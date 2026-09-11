# Codex app-server API audit — 2026-09-11

Scope: existing Cognia Codex app-server functionality, checked against the installed
`codex-cli 0.154.0` experimental TypeScript protocol and the official
[app-server documentation](https://learn.chatgpt.com/docs/app-server).

## MCP startup amplification

The native `mcpServer/startupStatus/updated` payload describes one server using
`name`, `status`, `threadId`, `error`, and `failureReason`. Cognia expected a
`servers` array and otherwise called global `mcpServerStatus/list`.

Each native startup event therefore triggered a new discovery pass. A regression
with 21 startup events reproduced 21 unintended inventory requests. An isolated
real Codex process confirmed that each inventory request launches temporary MCP
discovery processes. With multiple configured servers this amplifies startup work.

The adapter now merges individual startup events without making an RPC. Concurrent
inventory requests for the same thread share one promise, and an implicit refresh
uses a loaded thread when available. The native CLI model-picker path now calls
`model/list` without creating a thread or starting Cognia's tool bridge.

The real-process regression creates an isolated Codex home and one minimal local
MCP fixture. Thread creation starts that MCP exactly once; startup notifications
cause zero inventory requests. Three simultaneous explicit refreshes issue one
request. A later explicit refresh performs another discovery pass, as Codex itself
does even when `threadId` is supplied. Neither `threadId` nor
`detail: "toolsAndAuthOnly"` prevents that native discovery behavior in 0.154.0.

The fix does not rewrite the user's Codex configuration or disable configured
servers. Explicitly configured/inherited MCP servers still start normally.

## Other confirmed corrections

| Area            | Correction                                                                                             | Verification                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Skills          | Read `data[].skills`, deduplicate paths across working directories, use `forceReload`                  | Fixture regression and real isolated skill discovery                                          |
| MCP OAuth       | Send `name`; read `authorizationUrl`                                                                   | Native invalid-request reproduction and regression; external OAuth browser flow not performed |
| Thread list     | Read every `nextCursor` page; reject repeated cursors                                                  | Regression                                                                                    |
| Thread state    | Read authoritative start settings, hydrate fork history/settings, replace history after rollback       | Regression                                                                                    |
| Streaming       | Continue after `willRetry: true`; keep process exit terminal                                           | Asynchronous event regression                                                                 |
| Tool completion | Preserve dynamic/collaboration results and failed states; do not record declined file edits as applied | Event regressions                                                                             |
| MCP elicitation | Accept the current `openaiForm` alias                                                                  | Request/response regression                                                                   |
| Quotas          | Preserve multiple limit buckets and ordinary-usage state; merge sparse notifications                   | Read-only native response check and regressions                                               |
| CLI effort      | Forward current effort every turn; resolve model default when switched off                             | CLI session regression                                                                        |
| Status hook     | Reject stale refresh results after disconnect or agent switch                                          | Hook regressions                                                                              |

Existing initialization, approval decision shapes, turn cancellation, model
pagination, sandbox/config requirements, MCP configuration projection, extra skill
roots, and manager integration were also checked against the protocol and covered
by the focused suite. This audit does not claim implementation of every optional
experimental method in Codex.

## Validation and limits

- Final seven-suite run with the native test enabled: **439/439 tests passed**.
  The opt-in real Codex MCP test also passed separately.
- Scoped ESLint: passed.
- CLI JavaScript bundle: passed (`node scripts/build/build-cli.mjs --js-only`).
- Focused adapter/hook coverage: 94.98% lines, 94.73% functions, 75.16% branches.
  The repository's 90% branch target is not met.
- Full `pnpm test:coverage`: first shard reported unrelated failures in connector,
  chat, workflow, ingestion, and shell suites, then terminated with a JavaScript
  heap exhaustion. The full coverage gate did not pass.
- Final full TypeScript check reported 32 diagnostics outside the changed files;
  none in the six changed source/test files. The repository typecheck gate did
  not pass.
- No inference prompt, real external OAuth login, or desktop GUI interaction was
  used for this audit. Protocol fixtures, real local process behavior, and UI
  acceptance are separate evidence.

Reproduce the isolated native test:

```sh
COGNIA_CODEX_LIVE=1 pnpm exec jest --runInBand --silent \
  --runTestsByPath lib/ai/agent/external/codex-app-server-client.test.ts \
  -t 'does not amplify real MCP'
```

Restart the running Cognia TUI to load the rebuilt CLI and create a fresh adapter.

## Follow-up: active account routing and request amplification

The subsequent screenshot exposed a separate consumer bug: `/limits` and
`/balance` used `config.provider` even while an external Codex connection owned
the session. They therefore queried DeepSeek credentials and badged that account
as active. These commands now obtain the connected agent ID from the TUI runtime
and read that adapter's account snapshot. They do not create a session, launch
MCP discovery, or fall back to built-in provider credentials. Backend changes
clear stale quota state; both commands share request IDs so old responses cannot
replace a newer panel.

The native mapping preserves named quota buckets, actual window durations/reset
times, credits, individual spending limits, and ordinary-usage blocking. Missing
values remain unknown, including credit balances and window percentages. The
0.154.0 generated protocol and [official App Server documentation](https://learn.chatgpt.com/docs/app-server)
were used to check the wire fields.

Request controls added:

- Account refreshes share one in-flight read pair and a 30-second cooldown,
  including failures. Reopening a panel does not bypass it. Account-change
  notifications share one delayed refresh; failures alone schedule no retry.
- Disconnect/account changes invalidate old reads. Full quota responses retain
  fields absent from sparse pushes; newer pushed fields override older reads.
- Codex task execution has zero Cognia-level retries. A timeout or error cannot
  safely prove that the native turn and its tools never ran. Native server
  retries remain under Codex's control.
- Codex connections share one in-flight operation. Disconnect/removal serialize
  with pending handshakes; auth/quota errors stop connection retries. The native
  handshake owns its timeout and cleanup so an outer timeout cannot launch an
  overlapping process. Health recovery cannot restart an exhausted retry budget.
- Mounting the desktop status card no longer starts MCP inventory discovery;
  discovery remains an explicit refresh action.

All follow-up failure tests use mocks; no real account requests or inference
prompts were sent. The pre-fix tests reproduced 41 account reads for 40 refresh
callers plus connect, and four full task executions after a retryable failure.
Post-fix tests assert one read pair within the cooldown and one task execution.
These bounds apply to Cognia's outer logic, not internal Codex network behavior
or independent Cognia processes.

Focused limits mapper/controller/formatter coverage measured 95.84% lines,
96.75% branches, and 100% functions before the final localization adjustment.
This targeted run does not satisfy the whole-repository coverage gate, whose
other path groups were not collected. The full typecheck still has unrelated
test diagnostics; a follow-up incremental check exhausted its default heap.

Follow-up validation:

- Nine core suites: **774 passed, 1 opt-in native test skipped**. Scoped ESLint
  passed; the CLI JavaScript bundle was rebuilt after localization.
- New English/Chinese keys: `i18n:build`, `i18n:build:check`, and `lint:i18n` passed.
- After localization, both screenshot-equivalent App command fixtures passed:
  `/limits` and `/balance` rendered native Codex quota while DeepSeek remained
  configured. Effect orchestration regressions also passed **78/78**.
- The wider App suite still has nine failures in existing provider-picker,
  `/goal`, and `/mcp` command-menu interaction expectations. These differ from
  the new Codex quota command fixtures and were not rewritten as part of this fix.

## Follow-up: other external agents

The quota display now accepts the existing canonical native rate-limit event
stream, independently from API response headers and token/context usage. Claude
Agent SDK 0.3.227's stable `rate_limit_event` fields are preserved by the sidecar,
including utilization, reset time and extra-usage state. The deliberately
unstable SDK usage-query method is not invoked. Invalid event status does not
invent an `allowed` response.

The TUI keeps the latest report per native window, updates an open limits panel,
deduplicates warnings, and clears them when recovery is reported. Account/auth,
backend and process transitions clear previous quota state. Buffered quota/auth
events from cancelled turns cannot restore stale account data. Pushed quota
retains its original report timestamp when the panel is reopened.

Only the native `codex-app-server` preset invokes the existing Codex read API;
`codex-acp` does not inherit that API merely because it uses the same provider.
Other connected external agents without native quota reports show an explicit
localized availability notice. `/limits` remains reachable for that explanation.
Neither `/limits` nor `/balance` falls back to saved provider credentials,
starts a thread/MCP process, or probes an unsupported external quota surface.

ACP's [`usage_update`](https://agentclientprotocol.com/rfds/session-usage)
reports context occupancy and optional cumulative session cost. These values
are not subscription remaining quota and are not converted into a balance.
The same distinction applies to OpenCode/Pi session usage supported by the
existing adapters.

Authentication/payment/quota failures now stop Cognia's outer retries across
all external protocols, before custom retry patterns. Once a tool has started,
assistant output has begun, or a result reports generated content/token usage,
a transient failure cannot replay the complete turn. Ordinary transient
failures before accepted-work evidence retain the configured bounded retries.

Validation uses mocked events/errors throughout; no account requests or model
prompts were issued. Final uncached combined validation: 12 suites, 836 tests passed;
the sidecar mapper's malformed-status regression suite passed 28/28. Targeted
limits-data and LimitsPanel coverage exceeds 90% lines/branches, while the wider
provider-controller and full-repository coverage gates remain separate. Focused
ESLint and the CLI JavaScript rebuild passed. Repository-wide typechecking still
reports unrelated errors; the new quota test fixtures identified during that
run have been corrected. Full-repository typechecking and coverage are not
claimed as passing.
