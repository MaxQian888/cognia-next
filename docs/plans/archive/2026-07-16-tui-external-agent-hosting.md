# TUI as a Carrier for External CLI Agents (Codex / Claude Code) — Plan (2026-07-16)

**Status:** none of this is implemented. This is a design + phased build plan, not a
remediation of existing code.

**Goal.** Make the interactive `cognia-agent` TUI (`cli/src/tui/`) able to **host** an
external CLI coding agent — Codex and Claude Code first, the rest of the ecosystem for
free — the same way the desktop GUI does, instead of only running the built-in Cognia
sidecar agent. "Host" means: spawn the external CLI as a child process, speak its wire
protocol (ACP / Codex app-server), stream its output into the TUI's cell renderer, and
route its permission asks into the existing TUI permission overlay.

**Non-goals.** Not porting the inherently-graphical GUI surfaces. Not building a new
protocol — reuse the mature TS protocol plane. Not shipping container/kube execution
backends (those are ADR-0059 server concerns). Not solving `/team run` (that stays a
desktop-dispatch bridge; see §6).

**Origin.** A two-track read-only architecture sweep (GUI external-agent hosting · TUI
agent-launch architecture) on 2026-07-16, followed by a **source-level verification pass**
that falsified every load-bearing assumption of the proposed approach (§2). No fatal
blocker survived. Nothing was written to the repo besides this file.

---

## 0. Evidence standard & relationship to the parity plan — READ FIRST

### 0.1 This is the landing for N6 of `2026-07-16-tui-parity-and-industry-gaps.md`

That plan's **N6** ("no ACP support; this is the one strategic gap") called for a _spike
first_, not an implementation. This plan **is** the post-spike design: hosting Codex /
Claude Code in the TUI is, mechanically, "the TUI becomes an ACP + Codex-app-server
client." Do not run both as separate efforts. N6's spike is **Phase 0 here**.

Two adjacent items from that plan bear directly and are pulled in as open decisions:

- **N3 (sandbox).** A Node-side `child_process` spawner starts with **no OS confinement**,
  and the CLI is the shell most likely to run headless in CI / on a server. Sandbox scope
  is **D1** below.
- **N4 (i18n).** The TUI has no i18n and it is an open product decision whether Working
  Rule 4 even applies to Ink `.tsx`. New user-facing strings this plan adds inherit that
  decision (**D4**); do not unilaterally wire `next-intl` into the TUI.

### 0.2 Confidence labels (inherited)

| Label           | Meaning                                                            | What you must do                                     |
| --------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| **[CONFIRMED]** | Re-verified by reading the file end-to-end or running the command. | Trust it; re-locate by symbol if line numbers drift. |
| **[OPEN]**      | Needs a human decision.                                            | Do not decide silently — see §5.                     |

### 0.3 Evidence rules

- ripgrep, not bash `grep -r`; every absence claim needs a positive control.
- **The bundle is the oracle.** `build-cli.mjs`'s own header says: _"A few browser-only
  modules are aliased to Node stubs … add more here as the bundle surfaces them."_ The
  authoritative list of what must be aliased is produced by **running `cli:build` + a real
  spawn** (Phase 0), not by static reasoning. This plan's alias list (§3.3) is the _known_
  set; treat it as a lower bound until the spike closes it.

### 0.4 Repo gates that apply to every item

From `CLAUDE.md`, unchanged: co-located `*.test.ts` for any new/changed file under
`cli/src/**` and `lib/**`; coverage ≥90%; no simplifications; never `--no-verify`;
`pnpm changeset` (package `cognia-next`, **minor** — this is a user-facing capability). The
i18n gate is deferred to D4.

---

## 1. Architecture — the two-seam split (verified)

External-agent hosting is a deliberate **two-layer** design. This is the fact the whole
plan rests on.

| Layer                        | Lives in                        | Language                        | Responsibility                                                                                                                                                                        |
| ---------------------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Protocol / orchestration** | `lib/ai/agent/external/`        | **TS (reusable)**               | Four `ProtocolAdapter`s (`acp`, `codex-app-server`, `opencode`, `a2a`), `ExternalAgentManager`, `JsonRpcPeer` framing, session/permission/tool normalization, presets, env injection. |
| **Process**                  | `crates/cognia-external-agent/` | **Rust (not reusable in Node)** | Spawn child, process-group kill, line-framed stdio, exec/container/kube backends; emits frozen `external-agent://*` events.                                                           |

The two layers meet at exactly **one seam**: `lib/ai/agent/external/agent-transport.ts`.
Its `agentInvoke` / `agentListen` are **lazy-resolved by host** — Tauri `invoke`/`listen`
on desktop, `CompanionTransport.call`/`subscribe` on the headless brain — and
`supportsExternalAgents()` gates on `isTauri() || isHeadlessHost()` [CONFIRMED
`agent-transport.ts:23,38-61`].

**The interactive TUI is neither host.** It installs `StdioTransport` (a faithful Node
port of the _sidecar_ bridge) and its `protocol.ts` throws on any command the sidecar
doesn't define [CONFIRMED `cli/src/runtime/bootstrap.ts:198-200`,
`cli/src/runtime/protocol.ts:182`]. `cli/src` has **zero** imports of
`lib/ai/agent/external` [CONFIRMED]. What the TUI does today with "codex/claude-code" is
**read-only artifact reuse** — it imports their agent _definitions_ (`.claude/agents`,
`.codex/agents.md`) and runs them on Cognia's _own_ sidecar loop [CONFIRMED
`cli/src/agent/discover-agents.ts:170` `EXTERNAL_AGENT_SOURCES`]. It never spawns their
binary.

**Codex vs Claude Code is not two classes.** Claude Code = the generic ACP adapter →
`npx -y @zed-industries/claude-code-acp`. Codex = two specializations over the same
plane: native `codex app-server` (preferred) and the `codex-acp` shim. The only
wire-level difference is `omitJsonRpcVersion` in `JsonRpcPeer` [CONFIRMED
`ecosystem-adapters.ts`, `json-rpc-peer.ts`].

---

## 2. Verified findings — what falsification actually showed

Each row is a load-bearing assumption of "just reuse the TS plane behind a Node backend,"
checked against source.

| #   | Assumption                                             | Verdict                  | Evidence                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Protocol plane has no DOM/IndexedDB coupling           | **TRUE**                 | zero `window.`/`document.`/`indexedDB` in `lib/ai/agent/external/*.ts`                                                                                                                                                                                                                                                                      |
| 2   | Bundling `manager.ts` into the CLI is safe             | **TRUE**                 | `build-cli.mjs` uses `packages:"external"` + `splitting`; **no top-level Tauri calls** in the plane (import-safe); `cli/src/cli/entry.ts` already reaches the browser-only graph without executing it                                                                                                                                       |
| 3   | "Reuse `manager`/`acp-client` unchanged"               | **QUALIFIED**            | 3 sites use **raw `invoke`** off the lazy seam and will throw off-Tauri: `lib/native/external-agent.ts:8-9` (used by `checkExternalAgentCommandExists:125`, `acpTerminal*:155+`) and `lib/ai/agent/external/agent-hooks.ts:18` (`run_agent_hook`)                                                                                           |
| 4   | The Node process backend is small                      | **TRUE**                 | 3 commands + `check_command_exists` (`commands.rs:61,72,83,331`) and 5 trivial JSON events (`exec_backend.rs:42-62`: `{agentId,data}`, `{agentId,code,signal}`, `{agentId,state}`, `{agentId,status}`)                                                                                                                                      |
| 5   | External events map losslessly to `CaptureStreamEvent` | **MOSTLY**               | `message_delta`(text/thinking)/`tool_use`/`tool_result`/`usage_update` map 1:1; `permission_request` routes to the existing `onPermissionRequest` callback; **`plan_update` / `diff` / `error` have no `CaptureStreamEvent` slot** (`run-and-capture.ts:219-268` vs `types/agent/external-agent.ts:1483`) — this is the one real new module |
| 6   | External-agent auth is portable to the CLI             | **BETTER THAN EXPECTED** | `env-builder.ts` needs `getSettings` (Dexie) + `@/lib/subscription/*`; **both already run in today's CLI** — `entry.ts` installs fake-indexeddb, `lib/claude/build-options.ts` (already reused by the CLI) already imports `resolveCodexVaultCredential`, and `~/.cognia/credentials.json` already stores a subscription token              |

**Net:** no fatal blocker. The reuse boundary has exactly two shapes of work — (a) a small
set of raw-`invoke` modules to alias to Node, and (b) one event translator — plus glue.

---

## 3. The design — a **hybrid**, because the two layers reward opposite choices

The process/protocol layer rewards _maximum reuse_; the render layer rewards a
_CLI-native translator_. Do not pick one design for both.

```
 chat TUI ─ send ─▶ createExternalAgentSession        (NEW, sibling of createAgentSession)
                        │
                        ▼
          ExternalAgentManager.execute()  ◀── REUSED unchanged from lib/ai/agent/external
                        │  (AcpClientAdapter / CodexAppServerAdapter / JsonRpcPeer, REUSED)
     ┌──────────────────┼───────────────────────────────┐
     │ process plane    │ agentInvoke/agentListen seam   │
     ▼                  ▼                                ▼
 NodeExternalAgentBackend  ── spawn_external_agent ──▶ child_process (codex app-server /
 (NEW, ~1 file; ports        send/kill/check_exists    npx @zed-industries/*-acp)
  crates/…/process.rs)    ◀── external-agent://{stdout,stderr,exit,state-change,spawn}
                        │
                        ▼
       ExternalAgentEvent  ──▶  external-event-mapper (NEW) ──▶ TuiAction ──▶ reducer/cells
       (message_delta/tool/plan_update/diff/error/permission_request/usage_update/done)
```

### 3.1 Reuse (zero change to shared desktop code)

`AcpClientAdapter`, `CodexAppServerAdapter`, `OpenCodeClientAdapter`, `JsonRpcPeer`,
`ExternalAgentManager`, presets, `ecosystem-adapters.ts`, permission cascade,
`spawn-reclaim.ts`, `env-builder.ts`. All import-safe (finding 2).

### 3.2 New code (all under `cli/src/`)

1. **`cli/src/runtime/external/node-backend.ts`** — a Node process backend implementing the
   `agent-transport.ts` seam commands (`spawn_external_agent`, `send_to_external_agent`,
   `kill_external_agent`, `check_command_exists`) with `node:child_process` +
   `node:readline`, and emitting the 5 frozen `external-agent://*` event shapes into an
   `EventEmitter`. Port the _behavior_ (own process group, `kill_on_drop` equivalent,
   line framing) from `crates/cognia-external-agent/src/process.rs`; drop
   container/kube/terminal. ~150 LOC.
2. **`cli/src/runtime/external/host-branch.ts`** — teach `supportsExternalAgents()` /
   `agentInvoke` / `agentListen` a **third host** (CLI) that routes to (1). Implemented as
   a build alias (§3.3), not by editing the shared `agent-transport.ts`, to keep desktop
   code untouched.
3. **`cli/src/runtime/external/external-event-mapper.ts`** — the one substantial module:
   `ExternalAgentEvent → TuiAction`. Direct: text/thinking/tool/`usage_update`. Routed:
   `permission_request` → `onPermissionRequest`. **Decisions (bounded):** `plan_update` →
   existing `plan`/`todo` cell; `diff` → synthesize a `tool-result`-shaped cell; `error` →
   `error`/`notice` cell. Mirrors the desktop `event-to-parts.ts` but targets the CLI
   reducer, not `CaptureStreamEvent`.
4. **`cli/src/agent/external-agent-session.ts`** — `createExternalAgentSession`, a sibling
   of `createAgentSession` (`session-runner.ts:216`) whose `send` drives
   `manager.execute()` instead of `bootstrapSidecar` + `runAndCaptureAssistantReply`, and
   pipes through the mapper in (3). Reuse the existing `onPermissionRequest` wiring
   (`useAgentSession.tsx`, permission overlay).
5. **backend selector** — a field on `ResolvedConfig` (types already exist in
   `types/agent/external-agent.ts`) + a picker/flag in `cli/src/cli/chat.ts` so `chat`
   can start against `builtin | codex | claude-code | <preset>`. The chat mount branches
   session factory on it.

### 3.3 Build aliases (the finding-3 fix) — `scripts/build/build-cli.mjs`

Add one esbuild alias plugin (same mechanism as `stubNextPlugin`) redirecting the
raw-`invoke` modules to CLI implementations, so the reused adapters never reach Tauri:

- `@/lib/native/external-agent` → a CLI shim delegating to `node-backend.ts`
  (`checkExternalAgentCommandExists` via Node PATH probe; `acpTerminal*` throw
  "unsupported in CLI" — capability advertised **off**, see D3).
- `lib/ai/agent/external/agent-hooks.ts` → route to the CLI's own hooks loader
  (`cli/src/hooks/`) or a no-op for v1.
- `lib/ai/agent/external/agent-transport.ts` → the host-branch in §3.2(2), OR keep the
  shared file and make its non-Tauri branch resolve the CLI backend.

`cli:dev` (tsx) needs the same redirection via a tsconfig-paths/loader alias so
dev-from-source matches the bundle.

---

## 4. Phases (each is one commit; `[step] → verify`)

### Phase 0 — Spike: close the alias list & size the mapper [= parity plan N6]

- Import `ExternalAgentManager` into a throwaway `cli/src/` entry, `pnpm cli:build`, then
  spawn `codex app-server` (or `npx -y @zed-industries/claude-code-acp`) and run one
  prompt end-to-end with a minimal hand-written backend.
- **→ verify:** the build succeeds and the run produces streamed text; **capture the exact
  set of raw-`invoke`/Tauri leak points the bundle+run surface** and reconcile against
  §3.3. Record the real `ExternalAgentEvent` kinds observed to size the mapper.
- Output: a short spike note appended here; **no production code lands in Phase 0.**
- Changeset: no.

### Phase 1 — Node process backend

- Build `cli/src/runtime/external/node-backend.ts` (§3.2.1) + host-branch (§3.2.2) + the
  build/dev aliases (§3.3).
- **→ verify:** a unit test spawns a stub ACP agent (reuse `stub-acp-agent.mjs` shape from
  the Rust smoke path) and asserts the 5 event shapes byte-match `exec_backend.rs:42-62`;
  `check_command_exists` true/false against a real/absent binary. Co-located tests
  required.
- Changeset: no (internal until wired).

### Phase 2 — Event translator

- Build `external-event-mapper.ts` (§3.2.3) with the three routing decisions.
- **→ verify:** table-driven test mapping each `ExternalAgentEvent` kind → expected
  `TuiAction`/cell; assert `plan_update`/`diff`/`error` land in `plan`/`tool`/`error`
  cells and `permission_request` never becomes a cell. Golden-render a scripted ACP
  session into cells.
- Changeset: no.

### Phase 3 — Session factory + selector + chat wiring

- `createExternalAgentSession` (§3.2.4) + `ResolvedConfig` backend field + `chat` picker
  (§3.2.5). Route external `permission_request` into the existing overlay.
- **→ verify:** integration test — `chat --backend codex` (stub agent) runs a turn,
  renders assistant text, and a tool permission prompt appears in the overlay and, on
  approve, the turn completes. `/doctor` reports external-agent backend availability.
- Changeset: **yes (minor)** — first user-visible capability.

### Phase 4 — Auth reuse + hardening

- Keep `env-builder.ts` (finding 6); verify Codex subscription-token from
  `~/.cognia/credentials.json` and plain `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` env both
  reach the child; document that the external CLI's **own native login** (`~/.codex/auth.json`,
  Claude Code login) is the fallback and requires no Cognia injection.
- Apply the `SpawnPolicy` allowlist (`crates/cognia-external-agent/src/presets.rs:36-53`)
  in the Node backend as cheap defense even though the CLI spawn is local/trusted.
- **→ verify:** a real (non-stub) `codex app-server` turn on a machine with Codex logged
  in; a Claude Code turn via the Zed adapter. Record both in the spike note.
- Changeset: yes (patch) if it changes user-facing auth behavior.

### Phase 5 — Docs

- New subsystem page under `docs/content/docs/{en,zh}/` (use the `subsystem-docs` skill)
  and a new ADR (next free number) recording the hybrid design and D1–D4 outcomes.
  Update `cli/README.md`'s "Interactive TUI" section.
- **→ verify:** `pnpm docs:build` green.
- Changeset: no (docs).

---

## 5. Open decisions — DO NOT decide silently

- **D1 — sandbox scope [OPEN, inherits parity-plan N3].** Ship v1 unsandboxed, or gate the
  Node spawn behind macOS Seatbelt + Linux bubblewrap reusing the ADR-0028 policy
  vocabulary? The CLI is the shell most likely to run headless — this is a real safety
  call, not a detail. Answer before Phase 1 lands as anything more than dev-only.
- **D2 — seam completion vs build-alias.** Route `check_command_exists` / `acp_terminal_*`
  through the shared `agent-transport.ts` seam (cleaner architecture, edits `acp-client`
  imports), or keep the shared files untouched and redirect via CLI build alias (more
  surgical, zero desktop-code change)? Recommendation: **alias for v1, seam-completion as
  a follow-up** so desktop code stays frozen while the feature stabilizes.
- **D3 — ACP terminals.** GUI advertises terminals desktop-only (no headless arm). CLI v1
  should **advertise the terminal capability off** and Node-implement only `fs/*` (trivial
  via `node:fs`, matching the headless `agentReadTextFile` path). Confirm no target agent
  hard-requires terminals.
- **D4 — i18n [OPEN, inherits parity-plan N4].** New TUI strings this plan adds (picker
  labels, `/doctor` lines, errors) inherit the unresolved "does Working Rule 4 apply to Ink
  `.tsx`" decision. Do not wire `next-intl` into the TUI unilaterally.

---

## 6. Do NOT do these

- **Do not conflate this with `/team run`.** `team-controller.ts:145` dispatches team runs
  to a _running desktop app_ over HTTP; that is a separate, coarser bridge and is not the
  hosting path. Team execution stays renderer-only.
- **Do not port the Rust container/kube backends** (`container_backend.rs`,
  `kube_backend.rs`) into the CLI. Those are ADR-0059 server-deployment concerns; the CLI
  hosts locally.
- **Do not "proxy to a running desktop" as the primary answer.** A `CompanionTransport`
  path (CLI → running `cognia-server` `spawn_external_agent`) needs a live Rust host and
  breaks the CLI's "desktop-independent" premise (`cli/README.md`). Acceptable only as a
  documented degraded fallback, never the main design.
- **Do not edit the shared `lib/ai/agent/external/` adapters** to accommodate the CLI. The
  whole point of the hybrid is that they stay frozen; adapt via the seam/alias only.
- **Do not skip Phase 0.** The alias list (§3.3) is a lower bound; the bundle is the oracle.

---

## 7. Suggested order

Phase 0 (spike, closes the unknowns) → Phase 1 (backend) → Phase 2 (mapper) → Phase 3
(wiring; first user-visible commit) → Phase 4 (auth/hardening) → Phase 5 (docs). D1 must
be answered before Phase 1 ships as non-dev; D2/D3/D4 before Phase 3.

---

## 8. Provenance

Two parallel read-only tracks on 2026-07-16 (GUI external-agent hosting inventory · TUI
agent-launch architecture), then a source-level verification pass by the plan author that
falsified all six load-bearing assumptions in §2 — by reading `agent-transport.ts`,
`lib/native/external-agent.ts`, `agent-hooks.ts`, `manager.ts`, `acp-client.ts`,
`env-builder.ts`, `scripts/build/build-cli.mjs`, `cli/src/runtime/{bootstrap,protocol,stdio-transport}.ts`,
`cli/src/agent/{session-runner,discover-agents}.ts`, `cli/src/cli/entry.ts`,
`crates/cognia-external-agent/src/{exec_backend,commands,presets}.rs`, and the
`CaptureStreamEvent` / `ExternalAgentEvent` unions end-to-end. Builds on ADR-0048/0049/0051
(external-agent subsystem), ADR-0059 (headless brain + the `agent-transport.ts` host
seam), ADR-0064 (external-CLI-backed dispatch), and `2026-07-16-tui-parity-and-industry-gaps.md`
(N3/N4/N6). Nothing was written to the repo besides this file.

---

## 9. Phase 0 spike result (2026-07-16)

- Bundled `ExternalAgentManager` through `scripts/build/build-cli.mjs` and ran a real
  `codex app-server` turn using `codex-cli 0.144.4` on macOS arm64.
- The prompt streamed `PHASE0_STREAM_OK` through the manager. Observed normalized event
  kinds: `message_start`, `message_delta`, `message_end`, and `done`.
- The known raw-invoke aliases remain required: `lib/native/external-agent.ts`,
  `agent-transport.ts`, and `agent-hooks.ts`.
- Two additional host leaks were found and are addressed through the existing host
  capability seam rather than aliases: `codex-app-server-client.ts` had three direct
  `isTauri()` guards, and `config-normalizer.ts` rejected stdio before adapter connect.
- No further Tauri/raw-invoke leak appeared during bundle, initialize, thread creation,
  turn streaming, or shutdown. Background Codex MCP status probes logged expected
  best-effort timeouts and did not affect the turn.

## 10. Phase 4 real-agent verification (2026-07-16)

- `codex-cli 0.144.4 app-server` completed a strict-sandbox CLI turn and streamed
  `PHASE4_CODEX_OK`. The local subscription overlay was unavailable on this machine, so
  the run also verified the documented native `~/.codex/auth.json` login fallback.
- `@zed-industries/claude-code-acp@0.16.2` completed a strict-sandbox CLI turn and
  streamed `PHASE4_CLAUDE_OK`. Claude Code required write access to its exact persisted
  state paths (`~/.claude`, `~/.claude.json`, `~/.claude.json.backup`) and the npm cache;
  no broad home-directory write grant was added.
- Unit coverage verifies both CLI credential-file mappings (`CODEX_ACCESS_TOKEN`,
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) and
  inheritance of plain `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from the parent process.
  Loader-injection variables such as `NODE_OPTIONS` remain stripped.
