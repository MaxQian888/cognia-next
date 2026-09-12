# Devin CLI integration and ACP audit

Date: 2026-09-11. Host: macOS arm64. Installed Devin: `3000.10.21 (611c1cba)`.

## Result

Cognia can launch the installed, authenticated Devin CLI through native `devin acp`.
The real Cognia ACP adapter and CLI sandbox passed SWE-2 model selection, native file
read/write, session listing, reconnect/load, retained conversation context, and cancellation.
The Cognia MCP bridge also passes real read, write, host-tool, and git calls. Concurrent
conversations with identically named MCP servers return distinct per-session values,
including after another conversation closes and after reconnect/load. Tauri UI-to-Rust
execution was not tested live.

## Integration

- Preset `devin`, product ecosystem entry, and system-owned runtime catalog entry.
- Node and Rust launch allowlists admit `devin`; auth/config environment families include
  `DEVIN_` and `WINDSURF_`. Existing CLI login is reused through the unchanged HOME/data locations.
- Sandbox state roots: `.config/devin`, `.local/share/devin`, `.cache/devin`.
- English and Chinese preset guidance. Settings → Agents → Devin CLI pre-fills
  command `devin`, arguments `acp`. Team runtime selectors and badges also include
  the localized Devin label and existing brand icon.
- Models come from session config options. Launch alias `swe2` resolves to
  `swe-2-medium`; the live test selects that exact advertised ID through ACP.
- No client-identity spoofing is needed: `clientInfo.name = cognia` succeeds.

Devin's native modes are not Cognia's canonical permission IDs. The adapter preserves
native config options while mapping `acceptEdits` → `accept-edits`,
`bypassPermissions` → `bypass`, and `plan` → `plan`. `default` and `dontAsk`
use the more restrictive native `ask`; `dontAsk` retains local denial semantics.
For code changes, select Accept Edits / Code. Native Smart mode remains visible in
Devin's advertised options, with local approval handling kept conservative.

## Shared ACP corrections

1. Successful void file/terminal host handlers return JSON-RPC `result: {}`.
   Previously serialization omitted `result`, so the wire validator rejected the reply.
2. Prompt deadlines use execution timeout, then agent timeout, then five minutes;
   expiration sends `session/cancel` and resolves pending permission requests.
3. Session reload registers state before replay, merges returned and replayed
   model/mode/config metadata, permits workspace-scoped file callbacks during replay,
   and rolls back failed loads.
4. Stdio MCP is baseline ACP support; optional HTTP/SSE flags no longer falsely
   classify agents without those transports as having no MCP support.
5. Canonical ACP tool kind `edit` participates in Accept Edits handling.
6. Unsupported prompt content is rejected before execution listeners/state are installed.
7. HTTP transport non-success responses fail immediately.
8. The manager honors the configured permission default when the caller omits an override.
9. Synchronous JSON-RPC transport write failures clear pending requests and deadline
   timers. Best-effort cancellation notifications cannot throw out of a timeout handler.
   Regression tests reproduced the stale timer and pipe-error crash before the fix.

Optional advertised extensions are still capability-gated. Devin-specific
`_cognition.ai/*` product extensions are not claimed as implemented.

## Live evidence

Command:

```sh
rtk pnpm smoke:external-parity --devin-acp
```

Result: PASS, model `swe-2-medium`, mode `acceptEdits`.

- Read a random fixture and write a byte-identical output using native tools.
- Observe two tool results plus streaming, usage, config, and command updates.
- Find the created session in its workspace list.
- Disconnect, reconnect through a fresh adapter, and load the saved session.
- Confirm the model/mode survived; recall the random fixture in a tool-free follow-up.
- Abort a turn; receive `cancelled` and return to `idle`.
- Delete only the test session and remove its scratch workspace.

Browser verification on the existing dev server: Settings → Agents → Devin preset
opened an Add Agent dialog containing `devin`, `acp`, ACP, and stdio.
No desktop native invocation is inferred from that browser check.

### MCP compatibility and session isolation

Devin 3000.10.21 accepted ACP `session/new.mcpServers` but could not reliably discover
or call those servers. A standalone sentinel sometimes initialized, while model calls
returned `Server cognia-tools not found`; this does not establish Devin's internal cause.
The documented native MCP config path works with the existing CLI login.

`DevinAcpAdapter` now owns one ACP process per conversation. The Node and Rust process
backends prepare a private, immutable-per-launch `XDG_CONFIG_HOME` and merge the supplied
stdio/HTTP/SSE servers into `devin/mcp_config.json`. ACP session calls then send an empty
MCP array, avoiding two competing registration paths. Discovery/authentication uses a
separate process without conversation credentials.

The private copy preserves existing Devin settings, rules, permissions, and legacy/current
MCP entries. Injected names replace user-level names; conflicting higher-priority project
entries fail before launch. Other XDG applications retain their existing config paths.
Stdio MCP subprocesses receive the original XDG path unless explicitly overridden.
Directory/file permissions are 0700/0600. The internal config payload is removed before
spawn; only the host-created directory receives an extra sandbox writable grant. Failed
spawn, exit, kill, and normal close remove the owned copy. After a Devin exit, both
backends reap its owned process group so MCP descendants do not survive their parent. Remote process backends reject
this local-only payload rather than silently dropping it.

Devin permission requests can contain only `toolCallId`. The shared ACP adapter now merges
that request with the matching session's cached tool event and uses Devin's canonical
`cognition.ai/inferenceToolName` / `cognition.ai/toolName` metadata. This lets the existing
Cognia broker remain the sole approval authority for projected tools. Unknown tools retain
normal approval behavior. Host tools use the broker's `exec` authorization once; the bridge
no longer sends a redundant preliminary `authorize` request.

Child process exit is reconciled to only its own conversation. Manager session lookup
rejects stale child state and can resume the saved session through a fresh process without
closing healthy siblings. Disconnected ACP transports still tear down listeners, pending
permissions, and terminals. Fork preserves conversation metadata without copying another
conversation's broker credentials; callers supply fresh session-bound MCP options.

ACP has no standard `ping` method. A method-not-found response from the same live peer now
counts as responsive; timeout, disconnect, and other server errors remain unhealthy.

```sh
rtk proxy pnpm smoke:external-parity devin
rtk proxy pnpm smoke:external-parity --devin-acp
```

Live SWE-2 MCP bridge result: PASS. `read`, `file_append`, `ask_user`, and `git_status`
all returned successfully; `SMOKE.txt` contained exactly `cognia parity ok`. One broker
approval was requested for `ask_user`; there was no duplicate approval and no write
approval in Accept Edits mode. All test fixtures used existing login and isolated scratch
workspaces; no original user MCP config was rewritten.

The native/concurrency smoke also passes simultaneous same-name/different-value MCP
calls, closing one sibling without affecting the survivor, reconnect/load with fresh MCP
configuration, native byte-exact file copying, model/mode retention, conversation recall,
health checks, and cancellation. Its first expanded run found a native copy without the required trailing
newline; the prompt now explicitly specifies LF and the byte-exact assertion remains.

## Validation boundaries

Current MCP follow-up validation (2026-09-11):

- Session wrapper/manager: 202 tests passed, including child crash retirement, healthy
  sibling preservation, fresh-child resume, namespaced elicitation, and safe fork metadata.
  Wrapper focused coverage: 97.82% lines, 92.94% branches, 98.33% functions (scoped 90% gate passed).

- Shared ACP: 177 tests passed, including permission identity, method-not-found health,
  and listener/approval cleanup after process exit.
- Bridge: 22 Node unit tests and 84 Jest broker/policy/process integration tests passed; denied host calls
  never execute, approved calls ask once.
- Node config/backend/sandbox: 85 tests passed; Rust Devin config/policy/sandbox/process/remote
  checks: 11 tests passed, including an actual child/descendant exit fixture. New Node config
  helper coverage: 99.26% lines, 92.10% branches, 92.85% functions (scoped 90% gate passed).
- Updated setup guidance: 71 tests passed. i18n build, freshness, parity, and referenced-key
  checks passed. ACP v1 contract gate passed (schema 1.21.0, SDK 1.4.0).
- Final full typecheck completed with 41 diagnostics elsewhere in the shared tree and zero
  diagnostics in this task's changed files. Repository-wide typecheck remains failing.
- Full `pnpm test:coverage --out coverage/devin-mcp-20260911 --workers 2` was attempted.
  Shard 1/8 exhausted the configured 4 GB V8 heap (SIGABRT). Repository-wide coverage is
  therefore not established; this is separate from the focused regression results.

No live Windows/Linux or desktop Tauri UI-to-Rust result is inferred from these macOS CLI
and focused Rust tests. HTTP/SSE config mapping is covered by fixtures, while live SWE-2
MCP validation used stdio.

Earlier integration validation (before the MCP follow-up):

- ACP/manager/codec/SDK/feature/elicitation/dynamic-MCP/JSON-RPC: 402 tests passed,
  process exited successfully without forced termination.
- Preset/ecosystem/settings UI: 178 tests passed before final guidance wording updates;
  affected suites rerun after those updates (118 tests passed). Team runtime selectors
  and badges: 39 tests passed after adding Devin labels and colors.
- Launch policy/runtime catalog/Node backend: 91 tests passed.
- Rust policy: 22 tests passed; Rust sandbox: 19 tests passed.
- ACP v1 contract gate passed (schema 1.21.0, SDK 1.4.0).
- Focused ESLint and i18n build, freshness, parity, and referenced-key checks passed.
- Full typecheck initially hit a heap limit through the RTK filter. The script-preserving
  final script-preserving retry completed with 32 diagnostics in other shared-tree
  files (including gateway/provider/Kimi work); none remained in this task's changed
  source or test files. The repository-wide typecheck does not pass.
- Full repository coverage and the 90% threshold are not established. Focused ACP
  coverage measured about 78% lines before the last regression cases, and the global
  coverage gate cannot pass a filtered run. Free disk fell below 1 GB during validation.
- The broad capability audit has an existing static-scanner failure for all adapter
  registrations after manager refactoring; the runtime catalog audit passed.

## Sources

- [Devin native MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration)
- [Devin config precedence](https://docs.devin.ai/cli/reference/configuration/global-vs-local)
- [ACP method overview](https://agentclientprotocol.com/protocol/v1/overview)
- [Devin custom ACP setup](https://docs.devin.ai/cli/acp/jetbrains)
- [Devin commands and flags](https://docs.devin.ai/cli/reference/commands)
- [Devin permissions](https://docs.devin.ai/cli/reference/permissions)
- [ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema)
- Installed `devin --help`, `devin acp --help`, and live protocol responses.
