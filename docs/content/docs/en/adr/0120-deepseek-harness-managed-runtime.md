---
title: ADR-0120 — DeepSeek Harness managed runtime
description: "Integrates DeepSeek Harness as an external agent over two transports Cognia owns the host composition for, because upstream publishes no executable and no host plane."
---

# ADR-0120 — DeepSeek Harness managed runtime

**Status**: Accepted (2026-08-14)

## Context

DeepSeek Harness (DSH) is DeepSeek's open-source agent harness, built on Cordis. A prior investigation ([`docs/research/deepseek-harness-lessons-2026-08-13.md`](https://github.com/deepseek-ai/deepseek-harness)) concluded that Cognia should *learn from* DSH rather than migrate to it. That conclusion stands and is not revisited here. This ADR covers a narrower question: running DSH as an out-of-process external agent, the same way Cognia already runs Claude Code, Codex, and Pi. No Cordis enters the Cognia process.

Five facts, each established by reading published artifacts and running them locally rather than from documentation, shape the design. Each one breaks the obvious implementation.

**1. There is no executable to install.** Every other external agent is a CLI on `PATH`. DSH publishes none for either transport Cognia drives: `@deepseek-ai/dsh-acp` and `@deepseek-ai/dsh-sdk-client` both have `"bin": null` — they are Cordis plugin libraries. The one published binary, `@deepseek-ai/dsh` (`bin: dsh`), exposes only `web` and `plugin` and contains no ACP code at all. `dsh-sdk-client` states it plainly: *"No bundled-runtime resolution — callers name the runtime executable explicitly."*

**2. The npm packages ship only half the composition.** DSH splits its Cordis tree into an *agent plane* (persona, model-facing tools, tool presentation) and a *host plane* — "the registries themselves, the sandbox and approval stack, persistence, and the model route". npm ships only the agent plane's four presets. The host plane is where the security-critical wiring lives, and it is not published.

**3. `read-only` is not what makes a profile read-only.** DSH tools expose a model-invokable escalation: a denied call can be retried with `sandbox_permissions: "workspace-write"` plus a justification, and `ctx.approval` decides. Observed on a live run of Cognia's own composition against `deepseek-v4-flash`, asked to write a file:

```
1. write denied      -> "[sandbox: file access denied under read-only mode]"
2. model retried with sandbox_permissions: "workspace-write"
3. escalation refused -- no approval service composed -> fails closed
4. no file created
```

Step 3 is the entire guarantee. The profile is read-only because the escalation path terminates in a missing service, not because of the mode string.

**4. The two transports are near-complements, not tiers.** The SDK transport streams every durable fact — tool calls, reasoning, usage, subagent lineage — but its wire has no server-to-client request (approval is a dead capability upstream) and no prompt-cancel method. The ACP server is described by upstream as "automation-only": *"Committed answers only — live progress, reasoning, tool activity, plans, titles, and usage stay off the wire."* What it can do is carry a permission request and cancel a single turn. Neither supports session resume.

**5. `DSH_HOME` is a trust boundary.** `resolveDshHome()` falls back to `~/.dsh`. Under that root DSH reads `cordis.patch.yml` (home level and per-profile) plus a profile `package.json` whose `dependencies` are out-of-tree plugins. These layers apply **after every bundle layer**, may `insert` arbitrary plugin rows, may evaluate arbitrary JavaScript via the `!!js` YAML tag, and are live-watched. A file in the user's home directory could therefore mount write and network tools onto a profile Cognia had certified as read-only, while every digest still verified.

A sixth fact settled a question that had looked like a blocker: Cognia pins `@agentclientprotocol/sdk@1.3.0` and DSH pins `0.25.1`, but the package version is not the compatibility signal. The wire version is, and both are `PROTOCOL_VERSION = 1` — confirmed by handshake against a live server.

## Decision

Cognia owns and versions the DSH **host plane** as first-party source under `runtime/deepseek-harness/`, installs it into an isolated runtime home, and certifies it by digest.

**Three profiles, two transports.** `cognia-sdk-readonly` (default), `cognia-sdk-workspace`, and `cognia-acp`. A session may never move between transports: they differ in both what the user can see and what they can veto, so switching would silently change the safety properties of a running conversation.

**Two opposite approval invariants, for one reason.** The SDK read-only profile composes **no** `ctx.approval` provider: with no client to ask, one would hand the model self-service escalation. The ACP profile **must** compose one: there the request reaches the user, and omitting it would make every approval-gated tool fail closed with no way to proceed — a broken agent rather than a safe one. Both invariants are stated at the top of their compositions and pinned by tests.

**`DSH_HOME` is pinned inside the runtime home.** The launcher refuses to start unless it canonicalizes there, and `doctor` treats any stray patch layer as fatal on the read-only profile (a warning elsewhere, where the profile already grants write authority). Canonicalization defeats symlink and sibling-prefix escapes.

**Policy is TypeScript; hosts only gather facts.** `doctorDshRuntime()` and `buildDshChannelManifest()` live in `lib/ai/agent/external/dsh-runtime-install.ts`. The Rust and Node hosts return *facts* — digests, Node version, platform, stray patch layers — and the renderer renders the verdict. Duplicating those rules per host is exactly how the desktop and headless answers would drift apart. Install is two-phase for the same reason: the host stages and reports digests, the renderer builds the manifest (it owns the profile and capability vocabulary), the host writes it and swaps the tree in.

**Capability facts are data, not prose.** `DSH_SDK_CAPABILITIES` and `DSH_ACP_CAPABILITIES` are intersected with the static `RUNTIME_CAPABILITIES.external` table, which grants `session.resume`, `steer`, `set-model`, and `permissions.interrupt-resume` — none of which DSH supports on either transport. Without the intersection the compatibility gate would certify capabilities the runtime lacks and the UI would render controls that do nothing.

**`node` is not added to the spawn allowlist.** The launch is `node <launcher.mjs> <composition.yml>`, and admitting bare `node` would defeat the allowlist entirely. Both the Rust `SpawnPolicy` and the CLI backend admit it only when both paths canonicalize under the Cognia data root.

## Consequences

Cognia now maintains a Cordis host composition, including a sandbox and approval stack. That is a real maintenance surface the prior research did not anticipate, and it is the price of DSH publishing no host plane. It is deliberately confined to an out-of-process runtime.

Upstream is a developer preview that warns of compatibility-breaking changes, and `SESSION_FORMAT_VERSION` is `0` with no compatibility promise — it shipped six release candidates in three days. Identity is therefore the composition and lockfile digests, never the version string, which is recorded for display only. The session-event codec fails loudly on an unrecognized *required* event rather than dropping it; events upstream marks `ignorable` become bounded warnings.

The default profile cannot write, cannot run commands, and cannot ask the user anything. That is the correct default for an experimental integration, and it means the interesting cases require an explicit profile choice.

Windows is out of scope for now: `koffi` is a hard dependency of `dsh-fs-local` and would need building. On macOS and Linux it is installed but never imported, since its only use is behind a `win32()` path. `node-pty` is a static import in `dsh-subprocess-local` with no Linux prebuild upstream, so the workspace profile needs a node-gyp toolchain there — `doctor` reports that rather than failing at spawn time.

## Alternatives considered

**Vendor the host composition.** Rejected: it carries the sandbox and approval wiring and therefore belongs under review, not in a copied directory.

**Reimplement doctor in Rust.** Rejected: two implementations of the same security verdict is how the desktop and headless answers silently diverge.

**Add `@deepseek-ai/dsh-sdk-client` to the workspace and import it normally.** Rejected: the package belongs to the runtime home, and `manager.ts` is reachable from `app/layout.tsx`, so any specifier — even inside a dynamic `import()` — must resolve at build time and would break the mobile bundle. It is loaded from the installed runtime home by absolute path instead.

**Ship ACP only, since it can ask for approval.** Rejected: it reports almost nothing, so a user watching an agent work would see a long silence and then a block of text.

## References

- `runtime/deepseek-harness/` — compositions, launcher, pinned dependencies
- `lib/ai/agent/external/dsh-runtime-install.ts` — shared verdict and manifest policy
- `lib/ai/agent/external/dsh-session-event-codec.ts` — wire → canonical events
- `crates/cognia-external-agent/src/dsh_runtime.rs` — desktop lifecycle
- `tests/fixtures/dsh/` — recorded wire traces, upstream and Cognia-captured
- [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) — execution spec this integration resolves through
- [ADR-0049](./0049-external-agent-process-hardening) — spawn policy the `node` exception extends
