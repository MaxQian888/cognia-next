# Devin CLI integration and ACP audit

Date: 2026-09-11. Host: macOS arm64. Installed Devin: `3000.10.21 (611c1cba)`.

## Result

Cognia can launch the installed, authenticated Devin CLI through native `devin acp`.
The real Cognia ACP adapter and CLI sandbox passed SWE-2 model selection, native file
read/write, session listing, reconnect/load, retained conversation context, and cancellation.
This is not a claim of complete Devin interoperability: the Cognia MCP tool bridge failed
against this installed Devin build. Tauri UI-to-Rust execution was not tested live.

## Integration

- Preset `devin`, product ecosystem entry, and system-owned runtime catalog entry.
- Node and Rust launch allowlists admit `devin`; auth/config environment families include
  `DEVIN_` and `WINDSURF_`. Existing CLI login is reused without reading or copying credentials.
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

### MCP bridge limitation

```sh
rtk pnpm smoke:external-parity devin
```

Result: FAIL. The actual outgoing `session/new` contained both `cognia-tools` and
`cognia-plugin-tools`, with stdio commands and the expected environment variable names.
No credential values were printed by the diagnostic. Devin reported only its existing
configured MCP server; attempts to invoke the supplied servers returned
`Server cognia-tools not found` / `Server cognia-plugin-tools not found`.
This reproduced in both Ask and Code modes. The native ACP test above uses no MCP bridge.
No user MCP configuration was rewritten as a workaround.

## Validation boundaries

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

- [Devin custom ACP setup](https://docs.devin.ai/cli/acp/jetbrains)
- [Devin commands and flags](https://docs.devin.ai/cli/reference/commands)
- [Devin permissions](https://docs.devin.ai/cli/reference/permissions)
- [ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema)
- Installed `devin --help`, `devin acp --help`, and live protocol responses.
