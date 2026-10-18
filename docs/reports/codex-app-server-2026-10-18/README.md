# Codex app-server compatibility check — 2026-10-18

## The exercised 0.163.0 integration works without a production adapter change

The current stable npm release is `@openai/codex 0.163.0`. Cognia's existing
adapter passed the native fixture flow on macOS Apple Silicon using an isolated
copy of that release and the installed `0.159.2`. No CLI installation, account
selection, credential, endpoint, authorization flow, runtime certification or
production source was changed. The retained implementation work extends the
existing opt-in native test and adds two default partial-answer regressions.

This proves the exercised request/lifecycle subset, not general OpenAI service
availability, model entitlement, real-account authorization, or all platforms.

## Reproduction uses the real adapter and a local model fixture

The test is in
[`app-server-client.test.ts`](../../../packages/agent-codex/src/app-server-client.test.ts).
There is no new runtime module or parallel smoke framework: the existing native
MCP test was extended. The selected binary's own generated `ClientRequest.json`
validates outbound JSON-RPC calls. Responses and notifications are exercised by
the real binary but are not exhaustively JSON-Schema validated by this test.

The child receives only `NODE_ENV=test`, `PATH`, `TMPDIR`, and a temporary `CODEX_HOME`. Its
configured Responses provider points to a loopback fixture; no user tokens,
API keys or external inference service are used. The fixture supplies synthetic
text and usage. The native test has internal deadlines and cleanup for the
server, child, timers and temporary state, including failure before inference.

The temporary config pins `cli_auth_credentials_store="file"`, keeping credential
lookup out of the native keychain. The fixture additionally asserts that its
requests contain no credential headers, the adapter emits no login/logout RPC,
and no `auth.json` is created under the temporary home. Header checks retain only
a boolean, never header values. These assertions describe the fixture run; they
do not certify real-account authorization or inspect existing user credentials.

| Flow                           | Evidence / limit                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize and model discovery | Real CLI, generated-schema validation, nonempty model catalog; catalog is not an entitlement check                                                            |
| MCP and skills                 | Existing fixture discovery, concurrent-read coalescing, extra local skill discovery                                                                           |
| Turn input and streamed text   | Real `turn/start`, partial/final answer items on 0.163.0, one terminal event; two ordinary unit tests also cover streamed and completion-only partial answers |
| Usage                          | Synthetic input/output/cache values survive the native stream into `execute()`                                                                                |
| Native turn fork               | Fork through a completed turn and execute a new turn in the fork                                                                                              |
| Archive and restore            | Archive, list archived, unarchive, and list active after the fork has its own completed turn                                                                  |
| Steering                       | Native request accepted during a held loopback response; model incorporation of the steering text is not asserted                                             |
| Cancellation                   | Interrupt the held response and observe an unsuccessful execution result                                                                                      |
| Restart and resume             | Disconnect/relaunch, recover saved assistant history, and complete another fixture turn                                                                       |

One stronger assertion initially failed for a fork with no user turn of its
own. Native traces showed `source: "vscode"` and an empty preview; adding an
`appServer` source filter did not fix it. After a post-fork fixture turn, the
original query restored/listed it successfully. The source-filter hypothesis
and proposed production edit were discarded. Empty-fork discoverability is
outside this report's guarantee; the observation is not labeled a new upstream
regression without a cross-version reproduction of that exact case.

## Schemas add methods and optional fields

Stable and experimental schemas were generated from both binaries. The
[machine-readable comparison](schema-delta.json) records npm SHA-512 integrity,
artifact/binary SHA-256, schema bundle hashes, method counts, property changes,
and required-field changes. The downloaded npm artifact's integrity matched its
published metadata before execution. The temporary binary was not installed
globally and is not a repository dependency.

| Experimental surface | 0.159.2 | 0.163.0 | Method delta             |
| -------------------- | ------: | ------: | ------------------------ |
| Client requests      |     167 |     172 | Five added, none removed |
| Server requests      |      11 |      11 | None added or removed    |
| Server notifications |      83 |      85 | Two added, none removed  |

Added client methods concern predictions, attachment owners, read state, item
reads and Bedrock checks. Added notifications concern read state and predictions.
`MessagePhase` adds `partial_answer`; it remains answer text, while the turn's
terminal notification determines completion. Additional optional fields include
turn ancestry, thread exclusions, retained tool output and MCP login correlation.
No shared definition gained a required field in this structural comparison.
This comparison does not establish that all enums or runtime behavior are
unchanged. The exercised outbound calls are additionally checked against the
actual candidate schema because Cognia opts into `experimentalApi`.

## Verification is scoped to this integration

Final checks:

Both native-enabled version runs were repeated on 2026-10-18 after adding the
authorization-isolation assertions above. The candidate archive's SHA-512
integrity and archive/binary SHA-256 matched the published metadata and the
retained fingerprints in `schema-delta.json`. The installed CLI stayed at
0.159.2; the isolated candidate is removed after validation.

| Check                                                                                     | Result                |
| ----------------------------------------------------------------------------------------- | --------------------- |
| Candidate 0.163.0: six focused Jest suites, native test enabled                           | 279 passed, 0 skipped |
| Installed 0.159.2: same six suites and native test                                        | 279 passed, 0 skipped |
| Package TypeScript: `rtk proxy pnpm --filter @cognia/agent-codex typecheck`               | Passed                |
| Changed test: semantic diagnostics with root compiler options and Next/Jest ambient types | 0 diagnostics         |
| ESLint on the changed test                                                                | Passed                |
| Prettier and whitespace checks on owned changes                                           | Passed                |

The migration document's local links were checked. All three Mermaid diagrams
were rendered and visually inspected in local Chrome; a sequence-label syntax
error found during rendering was corrected before completion.

The suites cover the adapter, managed requirements, MCP config, rollout
history, app wiring and subscription chat bridge. To repeat them:

```sh
rtk env COGNIA_CODEX_LIVE=1 COGNIA_CODEX_BINARY=/absolute/path/to/codex pnpm exec jest --runInBand --runTestsByPath packages/agent-codex/src/app-server-client.test.ts packages/agent-codex/src/config-requirements.test.ts packages/agent-codex/src/mcp-config.test.ts packages/agent-codex/src/history.test.ts lib/ai/agent/external/integrations/codex.test.ts lib/subscription/codex/chat-bridge.test.ts
```

No coverage run, full build, native Tauri UI smoke, authenticated tool execution,
SIWC authorization, quota/entitlement check, Windows or Linux native run was
performed. The first typecheck invocation went through an RTK wrapper that
ignored the package filter and aborted with exit 134; it is not a passing
workspace check. The corrected package invocation above passed. Full workspace
typechecking is not established by this report. Existing `certifiedVersions`
remains unchanged because it affects lifecycle consent and requires stronger
release evidence than this fixture test.

## Authorization remains a separately reviewed migration

The [Sign in with ChatGPT proposal](../../plans/2026-10-18-sign-in-with-chatgpt-migration.md)
recommends separate registration/credential storage and explicit selection,
then staged app-server and direct-provider acceptance. It includes token
renewal, native process restart/resume, request restrictions, account isolation,
backup/downgrade behavior and rollback. It does not activate the new route.

The compatibility phase left authorization untouched. Later on 2026-10-18, the
maintainer separately approved the independent implementation described in the
[SIWC delivery report](../siwc-implementation-2026-10-18.md), while preserving existing
authorization and excluding real-account activation from validation. The fixture
results above remain scoped to the compatibility phase.
No SIWC implementation, feature flag, registration, Host ID, credential record,
or login/refresh/revocation flow is introduced. All implementation phases in the
proposal remain unapproved future work.

The proposal review additionally corrected three design boundaries: cross-process
refresh ownership needs an OS-backed lock beyond the existing process-local
manager; callback client-ID validation differs for first registration and
reauthorization; and Codex-internal file/shell/resume context is not proven to
traverse Cognia's existing PII gates. These are documented future acceptance
requirements, not production changes or evidence of live SIWC authorization.

Sources:

- [Official ChatGPT and Codex changelog](https://learn.chatgpt.com/docs/changelog)
- [Official app-server contract](https://learn.chatgpt.com/docs/app-server)
- [npm candidate artifact metadata](https://registry.npmjs.org/@openai%2fcodex/0.163.0-darwin-arm64)
- [`@cognia/agent-codex`](../../../packages/agent-codex/README.md)
- [SIWC app-server contract](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
