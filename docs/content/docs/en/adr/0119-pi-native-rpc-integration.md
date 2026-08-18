---
title: ADR-0119 — Pi native RPC integration
description: "Adds a built-in `pi-rpc` protocol that drives `pi --mode rpc` directly, replacing the community ACP bridge, without weakening the mandatory external-agent sandbox."
---

# ADR-0119 — Pi native RPC integration

**Status**: Accepted (2026-08-14)

## Context

Pi was reachable only through the community ACP bridge `npx -y pi-acp` (`lib/ai/agent/external/ecosystem-adapters.ts`). That bridge projects Pi's native RPC onto the smaller ACP vocabulary, so thinking levels, the steering and follow-up queues, the compaction lifecycle, the session tree with its forks, and usage detail were all lost or flattened. The bridge is also third-party code on the execution path, outside Cognia's certification.

Pi does expose a first-class local protocol: `pi --mode rpc` speaks a JSONL command/event stream over stdio. It is **not** JSON-RPC — frames are `{type, id, …}` command objects with `{"type":"response", "command", "success", …}` replies — so `json-rpc-peer.ts` cannot be reused, only imitated.

Four properties of that protocol were established by running Pi 0.84.1 locally rather than read from documentation, because each one breaks a naive implementation:

1. **Responses are not FIFO.** An `abort` reply arrived after the reply to a `get_state` issued later. Correlation must be by `id` only.
2. **A malformed inbound frame does not kill Pi.** It answers `{"type":"response","command":"parse","success":false}` **with no `id`**, so a correlator that assumes every response carries an id will leak a pending request forever.
3. **`set_thinking_level` accepts invalid input.** It returns `success: true`, silently clamps to `off`, and emits `thinking_level_changed` first. Validation must happen on the Cognia side against `get_available_thinking_levels`, whose result is per-model.
4. **`--no-extensions` does not isolate.** Skills under `~/.agents/skills/` and Pi's built-in inline extensions still load.

Separately, Node's `readline` — which `cli/src/runtime/external/node-backend.ts` uses to frame every external agent's stdout — splits on U+2028 and U+2029. `JSON.stringify` does not escape those characters, so a single valid Pi frame whose payload contains U+2028 is shredded into several unparseable fragments. The Rust host (`BufReader::lines()`) is byte-oriented and unaffected.

## Decision

Add `pi-rpc` as a built-in `ExternalAgentProtocol` with a `PiRpcAdapter` registered in `ExternalAgentManager.registerDefaultAdapters()`. No new execution rail, no Dexie schema version, and no ACP anywhere in the path.

**Framing.** The adapter owns a strict LF-only codec: split on the `\n` byte only, strip one trailing `\r`, never treat U+2028/U+2029 or a lone `\r` as a delimiter. It tolerates partial and multiple frames per chunk and enforces a 16 MiB frame and 32 MiB buffer ceiling, reporting `protocol_frame_invalid` past either. To feed it unframed bytes, `node-backend.ts` gains an opt-in raw-chunk forwarding mode used only by `pi-rpc`; ACP, Codex, and OpenCode keep the existing `readline` path unchanged. Their exposure to the same U+2028 defect is real but pre-existing and out of scope here.

**Sessions.** One Pi process per Cognia session, never shared via `switch_session`. Cognia mints the session UUID and passes `--session-id`, which Pi treats as "use this exact id, creating it if missing" — so resume is the same flag again and the persisted link stores only that UUID, cwd, and Pi version. No absolute session-file path enters any cross-device payload. Forking uses `--fork`. A per-host cap of four processes reclaims the least-recently-used idle process, or returns `resource_limit`.

**Versioning.** `0.84.1` is the certified version. Lower versions are refused with `runtime_version_unsupported`. Higher versions run but are reported as unverified and emit a signal, so a Pi upgrade degrades to a warning rather than an outage.

**Sandbox.** No exception. Pi runs under the same mandatory `cognia-external-agent-launcher` as every other external agent; when the launcher is missing or the platform is not macOS/Linux, the session is refused with `sandbox_unavailable`. ADR-0077's "never falls back to an unsandboxed process" is reaffirmed unchanged, and the escape hatches considered during planning (a desktop one-time confirmation, a CLI flag, a headless env var) were all rejected — Pi must not be the precedent that erodes that invariant.

**Extensions and permissions.** A first-party Cognia extension ships as raw TypeScript (Pi loads `.ts` directly; no build step) with a build-time SHA-256 pin. Isolation means `--no-extensions --no-skills --no-prompt-templates --no-approve`; `AGENTS.md`/`CLAUDE.md` context files are deliberately still loaded because they are data, not executable code. Because Pi retains its own built-in inline extensions even when isolated, the extension's `session_start` handshake asserts the expected extension set rather than asserting emptiness. No handshake within five seconds, or a hash mismatch, fails the session closed with `extension_handshake_failed`.

The extension intercepts every native Pi tool call through `pi.on("tool_call")` and maps the five canonical permission modes onto Pi's `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash` tools. `plan` and `dontAsk` additionally pin Pi's own `--tools` allowlist at spawn, so the restrictive modes have a process-level floor instead of resting on interception alone.

**Tool projection.** The extension reuses the existing tool host rather than introducing a new channel: it reads `COGNIA_TOOLHOST_{SOCKET,TOKEN,SERVER}` from its environment and speaks the established `hello` / `authorize` / `exec` protocol to the broker. The session-scoped control file proposed during planning was dropped as redundant and strictly worse than the env + `0600` unix socket already in place.

## Consequences

- The tool-host token now enters the Pi process environment, where the model's `bash` tool can read it. Today that token reaches only the trusted bridge. This is accepted because `authorize()` in the broker — not possession of the token — is the permission authority: every call is re-checked against tool visibility, workspace confinement, `needsApproval`, and the approval gate, so a leaked token confers nothing the sandboxed process could not already reach through the same-uid socket. It is recorded here because it is a genuine narrowing of defence in depth, not a non-issue.
- Windows and any host without a working sandbox launcher cannot run Pi locally. They reach it through a paired desktop or headless host, the same as every other external agent.
- Isolation disables the user's own Pi extension stack inside Cognia-run sessions. That is the point: community permission engines such as `pi-permission-system` also hook `tool_call`, and two engines intercepting the same call produce double prompts and unpredictable blocking.
- Cognia never reads Pi's credentials. Authentication diagnostics call only `pi auth check --provider <id> --json --no-refresh`; `--credentials`, `print-api-key`, and `print-bearer-token` are forbidden.
- `pi-acp` is retained as a separate experimental compatibility preset. Migration is explicit and reversible, updates the config in place so team, scheduler, and runtime references to the agent id survive, and does not assume an ACP session id maps onto a Pi session.

## Revision record

### 2026-08-18 — Pi's configuration surface and package system

The original ADR covered Pi's *runtime* only. Reviewing the integration end to
end showed the shape of the gap: Pi was the deepest runtime integration in the
repo and simultaneously the emptiest configuration one — no settings, slash
command, subagent, skill, MCP or memory import, no `VendorRoots` entry (so
`PI_CODING_AGENT_DIR` was ignored and the session path was hard-coded), no entry
in the migration wizard, and **zero code anywhere touching Pi's npm packages**.

This revision closes the closable half and records the rest as explicit
non-goals rather than leaving them as apparent oversights.

#### One clause is narrowed, not withdrawn

The Consequences section says:

> Cognia never reads Pi's credentials. Authentication diagnostics call only
> `pi auth check --provider <id> --json --no-refresh`; `--credentials`,
> `print-api-key`, and `print-bearer-token` are forbidden.

That still holds exactly as written, and is deliberately kept above rather than
rewritten. What has changed is that Cognia now *reads and writes*
`<pi agent dir>/settings.json`, which it previously never opened. The boundary
moved from "do not open the file" to:

- **A key allowlist.** `lib/pi-packages/settings-io.ts` parses `packages` and
  nothing else reaches a caller; the rest of the parsed object is dropped rather
  than returned, logged, or attached to telemetry or a support report.
- **Prefer letting Pi write its own file.** Mutations shell out to
  `pi install` / `pi remove` / `pi update --extension`, and edit `settings.json`
  directly only when Pi is not on PATH.
- **Never clobber an unparseable file.** An existing-but-unparseable
  `settings.json` refuses the write, mirroring the guard in `lib/claude/sync.ts`.
- **`auth.json` and `models-store.json` are still never opened.** Pi keeps
  credentials in a separate mode-600 file, which is out of scope entirely.

`PI_` is still absent from `ENV_PREFIX_ALLOWLIST`. That was a deliberate choice
in the original ADR and remains one — it is not an oversight to be corrected.

#### Now in scope

Settings, prompt-template, subagent, skill and memory import; `VendorRoots.piAgentDir`
/ `piSessionDir` honouring `PI_CODING_AGENT_DIR`; Pi in the migration wizard with
an honest per-artifact support matrix; MCP through a 14th adapter, `pi-mcp-adapter`
(its own id, because Pi's core ships no MCP and that file belongs to a third-party
package); and the package manager at `/plugins` → Agent packages.

#### Explicit non-goals

1. **Lifecycle hooks stay `sidecarOnly`.** Not a Pi limitation — this is uniform
   across every external backend. Changing it for Pi alone would make Pi the
   exception in a place where uniformity is the design.
2. **Rate limits and MCP logs stay `sidecarOnly` / `agentOwned`.** Same reason.
3. **No per-session `mcpServers`.** Pi's RPC protocol has no such parameter —
   `mcpServers` appears nowhere in its distribution. The `COGNIA_TOOLHOST_*`
   environment channel recorded above is the accepted trade-off; closing this
   needs a protocol change upstream, not a change here.
4. **No local Pi on Windows.** A consequence of the mandatory sandbox, already
   recorded above. Windows can now *configure* Pi — read its settings, manage its
   packages for another machine — but still cannot run it locally.
5. **No package registry integration.** pi.dev/packages is an npm-keyword gallery
   with no JSON API, and npm exposes only versions and download counts — never
   the overlap group, context cost or maintenance signal that make a catalog
   entry useful. The catalog is therefore curated in-repo and dated, with its
   prose in i18n so both locales stay checkable.

#### Known limitation

Cognia cannot read a Pi package's own configuration file, so overlap detection
works from the curated catalog alone. Concretely: `pi-permission-modes` ships a
Plan mode, but the recommended configuration removes `plan` from its
`cycleOrder` so the standalone plan package owns planning. The catalog therefore
does not list `plan` for it — and a user who re-enables `plan` there gets no
overlap warning.
