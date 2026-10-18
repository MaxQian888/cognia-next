# Kimi Code CLI 2.2.0 integration validation

Date: 2026-10-18 (Asia/Shanghai).

Kimi Code CLI 2.2.0 passed isolated, sandboxed ACP validation through Cognia's
existing CLI host and adapter. The reviewed installation/restore version and
English/Chinese setup guidance now target 2.2.0. No ACP implementation change
was required.

## Scope and isolation

- Platform: macOS 26.5.2, Apple Silicon; Node.js 26.5.0.
- Installed the exact npm package into a temporary prefix. The system Kimi
  installation remains 2.1.1.
- npm artifact: `https://registry.npmjs.org/@moonshot-ai/kimi-code/-/kimi-code-2.2.0.tgz`.
- npm integrity: `sha512-I1w2l6JGYEUSwA1DTvYrw/kDJYjJQKHFON+RON61epDeTITvwpXoDn4Kgl4atA82RfwcsMp3KG6k8Yaoj6LT0A==`.
- Used separate runtime state and throwaway workspaces. Authenticated checks
  reused privately copied CLI credentials, configuration and device identity;
  no existing sessions or workspace history were copied. Original source files
  were verified unchanged by SHA-256 after the checks.
- Disabled auto-update, background keep-alive and telemetry for the validation.
- Kept NotifyUser and workspace auto-trust unchanged. The supported range
  remains `>=2.1.1 <3.0.0`; this smoke result does not grant runtime certification.

## Native results

The existing `scripts/smoke/build-and-run-smoke.mjs --kimi-acp` runner bundles
the shared ACP integration and installs Cognia's CLI host. The authenticated
mode was run against the separate state using `--authenticated`.

| Check                                                                 | Result                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable identity and ACP protocol                                  | 2.2.0; ACP v1                                                                                                                                   |
| Missing credentials                                                   | Session creation correctly rejected                                                                                                             |
| Existing subscription login                                           | Reused successfully; fresh interactive login not repeated                                                                                       |
| Permission modes and thinking selector                                | Passed                                                                                                                                          |
| Streaming model response and stop reason                              | Passed                                                                                                                                          |
| Approved MCP call, file write/read and shell execution                | Passed                                                                                                                                          |
| Permission rejection and `dontAsk` enforcement                        | Passed; denied tools did not execute                                                                                                            |
| Image and embedded text-resource prompts                              | Passed                                                                                                                                          |
| Single- and multiple-choice question forms                            | Passed                                                                                                                                          |
| Running shell cancellation                                            | Passed; cancelled shell did not write its completion file                                                                                       |
| Native compaction trigger                                             | Acknowledged; no completion guarantee added                                                                                                     |
| Session list, fork, deferred fork preparation, close, load and resume | Passed                                                                                                                                          |
| stdio, HTTP and SSE MCP calls; fork MCP rebinding                     | Passed                                                                                                                                          |
| Session deletion and eventual index disappearance                     | Passed                                                                                                                                          |
| Distinct model selection                                              | Switched from `kimi-code/kimi-for-coding` to `kimi-code/kimi-for-coding-highspeed`, verified a real reply, then restored the original selection |

Machine-readable evidence:

- [Unauthenticated lifecycle](./kimi-code-2.2.0-2026-10-18/unauthenticated.json)
- [Authenticated execution and lifecycle](./kimi-code-2.2.0-2026-10-18/authenticated.json)
- [Distinct model selection](./kimi-code-2.2.0-2026-10-18/model-switch.json)

The model-selection check uses the same Cognia host, ACP adapter and preset as
the full smoke. It selects a distinct advertised model, asserts the updated
config option, checks an exact model-generated reply, and restores the prior
selection. It uses no bypass of the adapter's outbound gate or approval broker.

An initial run used the macOS `/var/folders` alias for external authentication
state and received ACP `-32603: Internal error`. Using the canonical
`/private/var/folders` path resolved this validation setup issue. The full
authenticated smoke passed with diagnostic stage logging, then passed again
using the original, uninstrumented runner. No sandbox or trust-policy changes
were made.

## Repository changes and checks

- Updated `KIMI_REVIEWED_VERSION`, preset setup guidance, both locale source
  hints and the runtime catalog's validation note.
- Updated management-card installation/restore expectations and added a check
  that preset and bilingual setup hints match the reviewed version.
- Regenerated locale artifacts with `pnpm i18n:build`.
- Focused Jest run: **8 suites passed, 552 tests passed**; coverage disabled.
- Scoped ESLint and Prettier checks: passed.
- Runtime catalog audit: passed (21 runtimes, 24 presets, no unpinned waivers).
- `i18n:build:check`, `i18n:sort:check` and final `lint:i18n`: passed.
- Full repository typecheck: exited 2 with 21 errors in 14 files outside the
  task-owned files. Examples include subagent settings sync, pet/subscription
  tests and the DeepSeek smoke. No task-owned file appeared in the diagnostics.
  The sidecar typecheck stage was not reached after the root TypeScript failure.
  See [typecheck diagnostics](./kimi-code-2.2.0-2026-10-18/typecheck.json).
- No Tauri window smoke, production build, full test suite or coverage run was
  performed. The native acceptance above exercises the CLI host's process,
  sandbox, filesystem and terminal ports; it is not a Tauri renderer test.

The working tree contained extensive concurrent changes. Only the Kimi
version, guidance, expectations and this evidence are part of this task.

## Upstream references

- [2.2.0 release](https://github.com/MoonshotAI/kimi-code/releases/tag/@moonshot-ai%2Fkimi-code@2.2.0)
- [CLI changelog](https://www.kimi.com/code/docs/en/kimi-code-cli/changelog.html)
- [ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
