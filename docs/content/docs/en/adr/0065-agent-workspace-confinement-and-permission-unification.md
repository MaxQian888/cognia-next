---
title: ADR-0065 — Agent workspace confinement & permission-model unification
description: "Closes the gap between the mature OS-level sandbox (ADR-0028) and the tools agents actually run. Adds an always-on, cross-platform 'workspace confinement' layer for the sidecar built-in file/bash tools (out-of-root writes escalate to approval; credential paths hard-deny), wires the OS sandbox per-teammate through the monotonic permission-ceiling cascade, unifies the always-allow path across both sidecar gates with target-scoped rules, and flips the companion-remote raw-fs commands from shadow-mode to enforced."
---

# ADR-0065 — Agent workspace confinement & permission-model unification

**Status**: Accepted (2026-07-06)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the OS sandbox (ADR-0028, `src-tauri/src/sandbox/`), the permission model (ADR-0020 computer-use, ADR-0041 command auto-mode), the monotonic permission-ceiling cascade (`lib/ai/agent/external/permission-cascade.ts`), and the sidecar `canUseTool` gates (`sidecar/dispatch/{anthropic,ai-sdk-tools}.mjs`).
**Inspiration**: Anthropic's [`sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) and the [Claude Code sandboxed-Bash](https://code.claude.com/docs/en/sandboxing) filesystem/network model (write=cwd, read=whole machine except credentials), and the six-step [Agent SDK permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions).

## Current state amendment (2026-08-13)

`TeammateConfigDialog` now exposes the existing sandbox policy editor, displays the inherited team ceiling, and persists only `clampSandboxPolicy`-narrowed overrides. This reuses the existing `SandboxResourcePolicy` schema and does not add a teammate-specific sandbox model.

## Context

The repo had **two mature but disjoint** confinement systems, and agents fell through the gap between them:

- **System A — OS sandbox** (ADR-0028): real, fail-closed, per-platform (Linux bwrap / macOS SBPL / Windows restricted-token+Job-Object) with an SSRF-filtering proxy and protected-path carve-outs. But it was reachable **only** via the `cognia-sandboxed-tools` plugin, Computer Use, canvas Python, and the terminal — **never wired into the Agent-Team / subagent / sidecar tool-dispatch path** — and it defaults **off**.
- **System B — permission model**: two layers (sidecar static fast-path `permission-resolver.mjs` + renderer rich auto-mode/modal) with a monotonic ceiling cascade.

The concrete gap: the sidecar built-in tools agents actually use (`read`/`write`/`edit`/`bash`/`grep`/…) ran **filesystem-unconfined by default** — `resolveToolPath` passed absolute paths verbatim. A complete, tested guard (`assertPathInside`) sat dormant behind a no-op placeholder (`normaliseAbsolutePath`) explicitly reserved "so a future user-confined sandbox mode has a single place to plug in". Separately, `src-tauri/src/files.rs`'s raw fs commands — reachable from the renderer **and from paired remote devices** — were in shadow mode (logged, never blocked).

## Decision

Confine agent tool execution **by default**, reusing the existing infrastructure, cross-platform (including native Windows where System A's network enforcement is still pending). Four workstreams:

### P1 — Sidecar workspace confinement (`sidecar/builtin-tools/confinement.mjs`)

An always-on middle layer, mutually exclusive with the heavy OS sandbox (when `sandboxEnabled`, System A takes over and this steps aside). Enforced in the **permission layer** (not the tool body — the body runs after approval and cannot re-ask):

- `classifyToolCallConfinement(policy, tool, input, cwd)` is **operation-aware**, matching Anthropic's model: a **mutator** (`write`/`edit`/`multi_edit`/`notebook_edit`/`bash`-workdir) whose target escapes every workspace root → `"ask"` (composes into the existing `permission_request` round-trip); a **reader** outside the roots is unconfined; **any** op resolving into a protected credential path (`.ssh`/`.aws`/`.git-credentials`/`.npmrc`/`.config/gh`/…) — directly or via a symlink escape — → `"deny"`. It only ever *adds* restriction (an in-root call contributes `null`, never an auto-approval).
- Composed into **both** sidecar gates via `combineVerdict(rulesetVerdict, confinementVerdict)` (deny > ask > allow), so the composition is identical on the Anthropic and ai-sdk paths.
- Defence-in-depth: mutator tool bodies call `assertNotSecretEscape` (activating the reserved `normaliseAbsolutePath` plug point) so a write can never backdoor a credential path even with no policy configured.
- Resolved in `resolveSendOptions` from `[cwd, …additionalDirectories]`, default-on (`AppSettings.workspaceConfinementEnabled`, overridable per character/session), gated on an active project. Settings toggle: `components/settings/sandbox/workspace-confinement-card.tsx`.

### P2 — `files.rs` shadow → enforce (origin-gated)

The raw fs commands take an `FsOrigin` (`Local` | `Remote`). `enforce_check_path` **hard-rejects** `Remote` writes (`write_text_file`/`ensure_dir`) that escape the registered roots — closing the paired-device exfil/backdoor-write hole — while `Local` calls and all reads stay in shadow mode (logged, never blocked) so existing renderer flows are untouched. The renderer command wrappers pass `Local`; `companion_api/rpc.rs` passes `Remote`.

### P3 — Per-teammate sandbox policy (wiring System A into Agent Team)

`ExternalSessionPermissionSpec` gains a `sandboxPolicy` that cascades monotonically via `clampSandboxPolicy` (`lib/sandbox/policy-bridge.ts`) — a child/teammate may only narrow writable roots, tighten the network, and lower CPU/memory caps, never widen. `teammateToCharacter` computes the clamped policy and sets `sandboxEnabled`/`sandboxPolicy` on the synthesized Character, which **activates the existing `resolveSendOptions` sandbox gate** for a teammate dispatch — the step that finally connects System A to the team runtime. Team- and teammate-level `sandboxEnabled`/`sandboxPolicy` live on `AgentTeamConfig`/`TeammateConfig`.

### P4 — Unified permission decision path

- `alwaysAllowTools` is now honored in **both** sidecar gates (populated onto `SendOptions` by `resolveSendOptions`), so an always-allowed tool skips the redundant `permission_request` round-trip — previously only the ai-sdk path read it and the Anthropic path relied on the renderer's `allowListRef`.
- "Allow always" persists a **target-scoped** rule (`Bash(git *)`, `Read(/path/x)`) via `deriveAllowRuleFromApproval` + `setToolRule` into `agentPermissions.toolRules` — strictly narrower than the old coarse tool-NAME grant — falling back to the bare name only when no target is extractable.

## Consequences

- Agents are confined-by-default on every platform, including native Windows, without requiring the heavy OS sandbox. Out-of-workspace writes prompt once (reusing the existing approval UX); credential paths are unconditionally blocked.
- Teammates/subagents can no longer exceed the team's sandbox ceiling (monotonic clamp), and enabling a teammate's sandbox now actually routes its Bash/Edit/Write through the OS sandbox.
- The confinement layer and the OS sandbox are mutually exclusive per session, so there is no double-confinement.
- **Follow-ups** (deferred to avoid stomping concurrent work): a `teammate-config-dialog.tsx` UI toggle for per-teammate sandbox, the `meta.json` + CLAUDE.md subsystem-map index entries for this ADR, and an optional `fs_set_root_enforcement` runtime toggle for P2.

## Key files

- `sidecar/builtin-tools/confinement.mjs` (+ `safety.mjs` `assertPathInside`/`canonicalisePartial` reuse), `sidecar/dispatch/{anthropic,ai-sdk-tools,permission-resolver}.mjs`, `sidecar/builtin-tools/core/{write,edit,apply-patch,notebook-edit}.mjs`
- `lib/claude/{build-options.ts,types.ts}`, `lib/claude/permissions/approval-rule.ts`, `hooks/chat/use-claude-chat.ts`, `components/settings/sandbox/workspace-confinement-card.tsx`
- `lib/ai/agent/external/permission-cascade.ts`, `lib/sandbox/policy-bridge.ts`, `lib/ai/agent/team/{teammate-character,dispatch-teammate}.ts`, `types/agent/agent-team.ts`
- `src-tauri/src/files.rs`, `src-tauri/src/companion_api/rpc.rs`
