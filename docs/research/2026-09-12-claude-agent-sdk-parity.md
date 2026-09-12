# Claude Agent SDK parity repair — 2026-09-12

The sidecar now pins Claude Agent SDK **0.3.269**, including its platform binaries.
The implementation targets that SDK's current contract; it does not add a second
compatibility implementation for older SDK protocols.

## Repaired behavior

- Latest typed options, thinking and system-prompt forms are validated and forwarded.
  Unknown nested SDK options fail validation rather than silently disappearing.
  Cognia-generated prompts use `snapshot: false` so resumed turns receive current
  instructions; explicitly configured SDK snapshot behavior remains authoritative.
- All 33 hook events are registered and selectable, with bilingual labels and Rust
  deserialization. Event-specific outputs survive command, native and plugin handlers.
  Permission denials remain denials, including PII rejection and model-switch timeout.
- `updateSettings` and `reloadOutputStyles` reach the SDK through the shared control
  protocol. Context usage accepts summary/full detail; plugin reload accepts its
  cache-impact option. TypeScript, Rust, sidecar and manifest declarations agree.
- Prewarm fingerprints cover effective startup configuration. Callbacks are rebound
  at claim; resume/fork and unshareable resources decline pooling. Expiration and
  closing during startup dispose of the subprocess. Text-only sends exercise actual
  dispatcher pool claims; sessions with in-process MCP resources use cold startup
  with an explicit warning.
- Managed permission-prompt MCP tools coexist with Cognia's hard permission, workspace
  and PII checks. Post-approval argument rewrites are rejected when they cannot be
  proven equivalent to the already-checked input. Unmanaged implicit delegates are
  explicitly refused. Latest decline-default and no-persistent-rule hints reach the
  shared approval UI, capture path, canonical transport, local/attached TUI and host
  enforcement. Terminal defaults honor denial, and suppressed persistent grants cannot
  be saved through stale callers.
- Initial and live MCP configurations use the same network and PII relay, including
  stdio catalogs and results. CLI dynamic updates use the required server-name map.
  Relay request correlation keeps server and client request-ID namespaces separate.
- SDK session operations carry their storage, workspace and host context. Persisted
  conversation bindings preserve the backend/workspace across resume, fork and import,
  including later global setting changes. The manager distinguishes filesystem rows
  from scoped SQLite rows.
- Custom Anthropic provider SDK opt-in selects the SDK and obtains an account-scoped
  required gateway ticket. It cannot silently switch engines or fall back to direct
  requests when gateway preparation fails; uncertified deployments remain experimental.
- Diagnostic hooks use the actual runtime scope and ignore stale responses. Tool
  metadata passes the PII gate; the gate distinguishes shared schema references from
  real cycles, keeping normal built-in catalogs usable.

## Verification and limits

- Five tests use the installed SDK and bundled Claude executable against a local mock
  Messages service: streaming, session identity, steering, sequential turns, and latest
  live controls. Tests use isolated temporary configuration and do not call a paid API.
- Focused option, hook, permission, prewarm, relay, storage, renderer and CLI regression
  tests pass. The expanded four-suite TUI run reports 253 passing tests and nine App
  failures in command-menu/provider-picker flows; the new approval assertions pass.
  Those nine tests do not invoke the approval gate; their command-menu/provider
  implementation paths were not changed by this repair.
  That broader TUI run is not reported as passing. The protocol modules' targeted
  coverage is at least 90% for lines,
  branches and functions; this is not a repository-wide coverage claim.
- Surface gate: 67 Options fields, 29 Query methods, 39 message variants, 33 hook events
  and 251 exports. The control gate also checks argument forwarding and capabilities.
  An API-name inventory alone is not treated as behavioral proof.
- A focused TypeScript semantic check reports zero diagnostics across 29 changed
  source files. Three isolated Rust tests compile the actual hook types and extracted
  control allowlist. Localization freshness, ICU validation and key checks pass.
- Full repository coverage exposed the shared-schema PII regression described above,
  now fixed and covered by focused tests, alongside unrelated workflow and CLI artifact
  failures. It then exhausted disk space; full TypeScript checking exceeded the heap limit. The
  full Tauri test build did not complete. These global checks are not reported as
  passing. No packaged desktop UI, real cloud account or cross-platform binary run
  was validated in this repair.

Official baseline: [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md),
[TypeScript API](https://code.claude.com/docs/en/agent-sdk/typescript),
[hook contracts](https://code.claude.com/docs/en/hooks).
