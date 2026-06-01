---
title: ADR-0041 — Agent command Auto-mode (rules + small-model safety gate)
description: "Completes the built-in agent's command-calling module with an OpenCode-style permission ruleset plus an OpenClaw-style auto-approval gate: a deterministic command-safety classifier (compound-command + privilege aware) auto-allows safe shell commands and denies catastrophes, an optional cheap-model judge resolves the uncertain middle, the dormant glob ruleset is wired into the sidecar canUseTool, and the whole policy is exposed to plugins via ctx.terminal."
---

# ADR-0041 — Agent command Auto-mode

**Status**: Accepted (2026-06-01)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the dormant glob ruleset from `feat/agent` (ADR permission-ruleset groundwork) and the terminal subsystem (ADR-0031/0033/0039)
**Affects**: `lib/claude/permissions/*` (new), `lib/claude/build-options.ts`, `lib/claude/types.ts`, `sidecar/dispatch/{anthropic,permission-resolver}.mjs`, `hooks/chat/use-claude-chat.ts`, `lib/plugin/registries/command-safety-registry.ts` (new), `lib/plugin/api/terminal-api.ts`, `lib/plugin/{core/manager,core/validation,security/permission-guard}.ts`, `types/plugin/plugin.ts`, `crates/cognia-cli/src/cmd_lint.rs`, `components/settings/agent-runtime/command-auto-mode-card.tsx` (new), `i18n/messages/{en,zh-CN}.json`

## Context

When the built-in agent runs a shell command (`Bash`, or the sidecar `shell_execute_advanced` / `start_process` built-ins), the renderer's `permission_request` handler always pushed a manual approval modal (unless the tool was on the user's always-allow list). There was no automatic safety judgement: `git status` and `rm -rf /` both prompted identically, and a permission **ruleset** module (`lib/claude/permissions/ruleset.ts`, an OpenCode-inspired `tool → glob → allow|ask|deny` resolver) had been written with its own tests but was **never imported anywhere** — dormant.

The goal: complete the agent's command-calling module with a real **Auto-mode** that decides command safety automatically — modeled on how OpenCode and OpenClaw gate execution — without weakening the existing approval path, and expose the whole mechanism to plugins.

### How the references actually work

- **OpenCode** — purely pattern/glob matching, no model. `Permission.evaluate` splits compound commands (`&&`, `|`, `;`) into segments, matches each against `tool → glob → allow|ask|deny` rules ("last/most-specific match wins"), and denies the whole command if any segment is denied.
- **OpenClaw** — exec-approvals: a default-deny gate combining tool policy + an allowlist + optional user approval, binding the canonical execution context (cwd, argv, pinned paths).

This ADR takes OpenCode's segmented glob ruleset, adds a deterministic safety classifier (so the user doesn't have to author rules for the obvious cases), and layers an **optional small-model judge** for the uncertain middle — the "小模型或者规则" the task asked for.

## Decision

A two-layer design. Pure, unit-tested cores under `lib/claude/permissions/`; thin wiring at the two enforcement points.

### Pure core (`lib/claude/permissions/`)

- **`command-parse.ts`** — `splitCommandSegments(command)`: quote- and depth-aware tokenizer that breaks a command line into head-command segments, recursing into `$(...)` / backtick substitutions and `(...)` subshells so a hidden `echo $(rm -rf /)` still surfaces the `rm`.
- **`command-safety.ts`** — `classifyCommand(command)`: the deterministic rules tier. Per-segment classification against SAFE / ASK / destructive head sets, git/npm/cargo subcommand awareness (`git status` allow, `git push` ask), a `sudo`/`env`/`timeout` wrapper unwrap that escalates privilege, an `rm -rf <critical-path>` / `dd of=/dev/…` / `mkfs` / pipe-to-shell / fork-bomb catastrophe scan, and a curl heuristic (GET allow, data/POST/-o ask). Worst verdict across the chain wins.
- **`command-judge.ts`** — `judgeCommandSafety(client, command)`: the optional model tier. A cheap background `LlmClient` (the same `buildUtilityLlmClient` the title generator uses) returns strict JSON `{safe, risk, reason}`. **PII-gated** (`hasNoLeakingPii`) — a command carrying secrets is never sent. Cached by command; null on any failure.
- **`auto-mode.ts`** — `evaluateAutoDecision(...)`: orchestrates the three sources, highest authority first — explicit user/plugin rule → deterministic classifier → model judge — and resolves to `allow` / `ask` / `deny`. Anything uncertain falls to `ask` (the safe default).
- **`ruleset.ts`** (activated) — gained `resolvePermissionDetailed` (reports the winning layer) and `resolveBashPermission` (compound-command-aware, explicit-only) so the dormant module is finally consumed.
- **`command-from-tool.ts`** / **`auto-mode-runner.ts`** — map a tool call to its command string and run Auto-mode from settings; keeps the chat hook's change tiny and testable.

### Layer A — sidecar static ruleset (`canUseTool`)

`build-options.ts` serializes the user's `agentPermissions.commandRules` into `SendOptions.permissionRuleset`. `sidecar/dispatch/permission-resolver.mjs` (a JS mirror of `ruleset.ts`, **explicit-match-only** — no blanket `*: allow` that would bypass every approval) is consulted in `canUseTool`: an explicit `allow` runs without a round-trip, an explicit `deny` rejects, everything else falls through to the normal `permission_request`. Fail-open on any error.

### Layer B — renderer Auto-mode (`permission_request`)

In `use-claude-chat.ts`, after the always-allow check and before the manual modal, a shell-command `permission_request` runs `runAutoModeForTool`. A non-`ask` decision short-circuits: `allow` auto-approves, `deny` auto-denies (with the reason on the tool result); `ask` falls through to the existing modal. This is where the model tier lives (async is fine in the renderer). Fail-open: any error shows the normal prompt.

### Settings, plugins, parity

- **Settings** — `AppSettings.agentPermissions = { autoApprove: { enabled, mode: "rules" | "rules+model", denyOnHighRisk, judgeModel? }, commandRules }`. Off by default. A new **Command Auto-mode** card in the Agent Runtime → Permissions & Tools tab toggles it, picks the engine, and edits command rules.
- **Plugins** — `ctx.terminal.registerCommandSafetyRule(...)` (declarative `command-glob → verdict`, merged below the user's rules) and `ctx.terminal.classifyCommand(...)` (read-only), gated by a new non-dangerous `terminal:safety` permission. Plugin rules live in `command-safety-registry.ts` and are dropped on plugin disable. Rust `cmd_lint` parity keeps the permission valid for `cognia lint`.

## Consequences

- Safe commands stop nagging; catastrophes are blocked before they reach the user; the uncertain middle either prompts (rules-only) or is judged by a cheap model (rules+model). All opt-in.
- The dormant OpenCode-style ruleset is finally wired and serves the static fast-path.
- Two enforcement points, both fail-open — a bug in the new code degrades to the old "always prompt" behavior, never to "silently run".
- Compound-command safety is enforced renderer-side (Layer B has the full parser); the sidecar fast-path (Layer A) only short-circuits explicit whole-/segment-glob rules, which is sufficient because unmatched commands round-trip into Layer B.
- Privacy: the model never sees a command containing detected secrets/PII; the model tier is off unless explicitly enabled.
