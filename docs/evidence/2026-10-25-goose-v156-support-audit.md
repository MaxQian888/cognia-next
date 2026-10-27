# Evidence ledger: goose v156 support audit

- Status: verifying
- Lane: standard
- Created: 2026-10-25
- Updated: 2026-10-25
- Related: ADR-0090, ADR-0216, ADR-0217; protocol/external-agent-runtimes.json; Goose v1.56.0

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 帮我校对一下Goose目前的支持缺口，4. Goose v1.56.0：Subagent 恢复、并发控制与 Code Mode Runtime

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                           | State    | Basis                                                                                                      | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Goose v1.56.0 is a stable release published at 2026-10-23T15:49:34Z.                                                | Verified | Official GitHub release API, inspected 2026-10-25.                                                         | -          |
| O2  | Cognia launches system Goose through native ACP, with developer enabled and approval mode enforced.                 | Verified | ecosystem-adapters.ts; packages/agent-acp/src/vendors/goose.ts, 2026-10-25.                                | -          |
| O3  | The runtime catalog admits >=1.52.0 <2.0.0; certifiedVersions contains only 1.52.0.                                 | Verified | protocol/external-agent-runtimes.json, 2026-10-25.                                                         | -          |
| O4  | No Goose executable is discoverable on the current PATH.                                                            | Observed | Python shutil.which('goose') returned None, macOS, 2026-10-25.                                             | -          |
| O5  | At the audit baseline, a completed ACP tool result dropped Goose's subagentSessionId metadata.                      | Verified | Pre-implementation client projection and cache probe, 2026-10-25; repaired in O10.                         | -          |
| O6  | At the audit baseline, Cognia did not advertise or handle Goose custom notifications.                               | Verified | Pre-implementation feature-profile/client probe, 2026-10-25; repaired in O10.                              | -          |
| O7  | Explicit GOOSE_MAX_CONCURRENT_SUBAGENTS=2 survives the CLI environment filter; Rust permits the same GOOSE_ prefix. | Verified | CLI helper execution returned 2; crates/cognia-external-agent/src/presets.rs prefix allowlist, 2026-10-25. | -          |
| O8  | A synthetic Goose 1.56.0 version observation returns supported-uncertified, not certified.                          | Verified | Production assessRuntimeVersion + current catalog, cache probe, 2026-10-25.                                | O3         |
| G1  | Correct the supplied release summary and audit Cognia support for the listed changes.                               | Agreed   | User request, 2026-10-25.                                                                                  | -          |
| C1  | The initial request authorized an audit; implementation was authorized separately by G2.                            | Verified | User requests, 2026-10-25. Historical scope only.                                                          | G1         |

| G2 | Implement the full audited Goose integration differences and verify real behavior. | Agreed | User follow-up, 2026-10-25. | G1 |
| C2 | Preserve shared edits and route child recovery through parent permission and PII boundaries. | Verified | User instructions and ADR-0217, 2026-10-25. | G2 |
| O9 | Official macOS arm64 Goose 1.56.0 was prepared under the task cache and executed through Cognia's ACP/sandbox path. | Verified | Release archive SHA256 52f3f8d62e3d144c5de70c5c471de39d8b92c24d41d5b3436eb8bab11ba4bc24 matched the official asset digest; version probe and real smoke logs, 2026-10-25. | O1 |
| O10 | Typed child identity, passive inspection, parent recovery and custom status/usage projection are wired locally and through the existing Host facade. | Verified | Focused behavioral suites; independent wiring/PII review; official-runtime smoke, 2026-10-25. Remote transport verified with fixtures, not a paired physical Host. | O2, G2 |
| O11 | Boa approves the outer JavaScript batch; inner tools do not separately prompt. Mandatory rules need an outer-batch guard and native approve mode. | Verified | Official binary nested write/deny/cancel smoke, native code_execution.rs, mandatory policy and legacy-auto reload tests, 2026-10-25. | O9 |
| O12 | Goose archives are passive, filter native visibility and scope SQLite identities by store; isolated launches relocate state and disable shared keyring. | Verified | Goose/portable-source tests; native read-only SQLite and Node/Rust isolation tests; history/native reviewer findings repaired, 2026-10-25. | G2, C2 |
| O13 | Inherited Code Mode children do not expose their final-output tool in the tested 1.56.0 runtime; developer-only children of a Code Mode parent do complete and recover. | Verified | smoke-code-mode-child-final.log reproduces missing tool; smoke-final-with-limitation.log and acceptance.json verify the negative case plus extensions:[developer] workaround, 2026-10-25. | O9 |

## Problem frame

The initial phase produced a release correction and support matrix (G1). The authorized follow-up (G2) fills the host integration gaps: native child observation/recovery, runtime configuration, custom events, passive history import and isolated state. Verify the official binary with a loopback deterministic provider while preserving parent approval/PII and concurrent edits (C2). System installation, production credentials and paid inference remain outside this implementation. Runtime-owned compaction, provider pricing and JavaScript execution remain in Goose; Cognia supplies their transport, controls and truthful evidence boundaries.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                       |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| scale        | medium | Release/PR source, ACP package, runtime catalog, launch environment and UI consumers.                             |
| technical    | medium | Native delegation differs from host sessions; Boa changes the tool execution contract.                            |
| coupling     | medium | Shared ACP adapter and CLI/Rust launchers; inspect both environment filters.                                      |
| requirement  | low    | G2 explicitly authorizes implementation after the initial audit.                                                  |
| verification | high   | Official binary and loopback provider are available; native desktop UI and authenticated billing remain separate. |
| risk         | medium | Incorrect claims could misstate recovery, approval and compatibility guarantees.                                  |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                          | Severity | Source                                                                 | Claim                                                                  | Refuted by                                                               |
| --- | -------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | Release prose overstates or understates upstream behavior.                             | medium   | Official release and PR descriptions                                   | Every corrected claim has version-specific primary evidence.           | v1.56.0 source contradicts the prose.                                    |
| R2  | Generic ACP session recovery or host concurrency is mistaken for native child support. | medium   | ADR-0090 and ADR-0217                                                  | Separate runtime-inherited behavior from host control surfaces.        | Production code supplies an unreported child control/viewing path.       |
| R3  | Safe MCP aliases or new runtime tools change identity and approval behavior.           | medium   | Catalog: permissions and runtime wiring; upstream PR #12875 and #12952 | Compatibility remains scoped until a real tool round trip is verified. | Existing integration tests exercise the exact new contract successfully. |
| R4  | Mocked green checks are reported as live certification.                                | medium   | Catalog: cross-shell verification; runtime catalog                     | Evidence labels identify static, mocked and real-env limits.           | Report claims a live v1.56.0 run without an artifact.                    |

| R5 | Child inspection or resume starts an unauthorized run or replays effects. | high | ADR-0090/0217; upstream child ownership invariants | Read-only inspection cannot prompt children; recovery uses the owning parent and normal outbound gate. | Inspection starts a run or a foreign/completed child can be resumed by the host. |
| R6 | Configuration/history support leaks credentials or crosses state roots. | high | ADR-0216; catalog state isolation and data boundaries | Per-config roots are confined and imported history remains passive. | Import triggers model calls or one config reads another config state. |
| R7 | A JavaScript batch or persisted auto session bypasses mandatory approval rules. | high | Real Boa nested-tool experiment and independent wiring review | Any mandatory rule forces batch review; new/load/resume restore native approve before exposing a session. | A guarded batch mutates a file without a host request or rejecting the batch still writes. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk       | Method                                                                               | Independence | Evidence                                                                                                                                                | Coverage                                                                                          | Status |
| --- | ---------- | ------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1         | Compare release metadata, PR changes and tagged source with each supplied bullet.    | tool         | Official release API: published_at=2026-10-23T15:49:34Z, prerelease=false; PRs and tagged sources linked below.                                         | v1.56.0 upstream evidence only; no independent upstream test rerun.                               | passed |
| V2  | R2, R3     | Trace preset, ACP events, permission identity, runtime catalog and both env filters. | tool         | Production-module probe reproduced O5/O6/O7/O8; exact inputs and commands below.                                                                        | Current dirty working tree; CLI env executed, Rust env filter inspected; no released build claim. | passed |
| V3  | R2, R3, R4 | Run existing focused Goose profile, ACP, preset, catalog and version tests.          | tool         | Two Jest runs: 8 suites passed; 584 tests passed, 1 existing test skipped. Exact commands/results below.                                                | Headless contract checks; no model calls or native desktop.                                       | passed |
| V4  | R4         | Prepare official Goose without changing the system installation.                     | real-env     | O9: official digest/version confirmed; isolated binary under .cache/goose-v156-implementation/goose.                                                    | macOS arm64 only; no production account.                                                          | passed |
| V5  | R1, R4     | Validate ledger, formatting and task-only diff.                                      | tool         | Prettier --check and git diff --no-index --check passed; task status contains only the new audit Markdown. Final ledger check is run after this update. | Audit Markdown only; no product edits.                                                            | passed |

| V6 | R2, R3, R5 | Red/green child metadata, custom event, ownership, read-only viewer and config tests. | tool | Targeted tests reproduce metadata loss, cross-store merge and audience leak before fixes. Final 24-suite run: 23 passed, 1268 tests passed, 1 unrelated OpenCode assertion failed; added history-errors suite: 4 passed. Logs under .cache/goose-v156-implementation/. | Local and remote facade fixtures, escaped read-only viewer, host revision reset, parent callback/PII, configuration serialization. No physical remote Host. | passed |
| V7 | R3, R4, R5 | Official v1.56.0 local-provider smoke for ACP, child recovery, Boa, aliases, Skills and cache usage. | real-env | smoke-versioned-final.log and acceptance.json: official runtime exits 0; failed/cancelled child recovery, completed refusal, peak concurrency 1 for two tasks, Boa discovery/nested mutation/denial/cancel/output bound, three MCP aliases, Skills sentinel, two foreground Responses cache keys. | Real binary, production adapter and OS sandbox; local Chat Completions/Responses and HTTP MCP fixtures. No provider billing/quality measurement or Linux run. | passed |
| V8 | R4, R6 | History/isolation tests, focused native checks and fresh auditors. | tool | Native history 1/1 and Goose launcher/isolation 5/5 pass. Browser import normalization, duplicate store IDs, user audience, malformed metadata/content and error wrapper pass. PII/wiring/i18n/native/test-gap reviewers completed; findings repaired. | Known schema-17 SQLite projection and official JSON exports; read-only DB byte comparison; no native desktop import UI run. | passed |
| V9 | R4, R5 | Browser/native UI verification of settings, status and read-only child viewing. | real-env | Browser localhost3000: Goose form, concurrency 2, Code Mode args developer,code_execution confirmed in AX state and screenshot; draft cancelled. Child inspection/recovery UI verified in RTL. Native screen reports workstation locked. | Browser form is real; child-view browser/native and paired-device UI not exercised. | blocked |
| V10 | R7 | Exercise opaque batch policy and legacy-auto session restoration. | real-env | Batch-policy red/green; Goose mode red run 31 failures then 395/395 client/profile tests pass. Real smoke: auto session persisted, reloaded with mandatory rule and host bypass policy, request surfaced and rejection preserved file. | All five host modes mocked on new/load/resume; actual macOS legacy load and Boa approval/rejection. | passed |
| V11 | R4, R6 | Run formatting, type/lint/i18n/static-export/capability gates and final diff review. | tool | Task ESLint, ACP package typecheck, sidecar typecheck, i18n build/check/sort/lint, static-export and agent-capability gates pass. Full repository typecheck now passes; global lint and one existing OpenCode test fail outside Goose changes. Production build result is recorded below. | Full web production static export passes; no full Tauri crate test claimed. | failed |
| V12 | R2, R3, R4 | Complete a child inheriting Code Mode and check an extension-restricted child alternative. | real-env | Official 1.56.0 child catalog has no final-output tool; inherited child remains incomplete after recovery. Same Code Mode parent succeeds with delegate extensions:[developer]. Final smoke records the known limitation explicitly instead of claiming inherited completion. | Positive developer-only workaround verified; inherited-Code-Mode child completion fails upstream. | failed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                           | Action   | Based on                       | Reversal trigger                                                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------ | ------------------------------------------------------------------------------- |
| D1  | 2026-10-25 | Audit official tagged sources and current integration; report gaps without changing product code.                  | diagnose | G1, C1, O1, O2, O3             | User requests implementation or concrete behavior contradicts the source audit. |
| D2  | 2026-10-25 | Report runtime inheritance separately from missing child UI/custom-event integration and unverified compatibility. | diagnose | G1, C1, O2, O3, O5, O6, O7, O8 | A new client integration or real v1.56.0 acceptance changes the evidence.       |

| D3 | 2026-10-25 | Reopen for authorized implementation with behavioral checks and isolated upstream runtime acceptance. | implement | G2, C2, O2, O3, O5, O6, O7, O8 | Official contracts or runtime evidence refutes the integration route. |
| D4 | 2026-10-25 | Treat Code Mode approval as a batch; force review under mandatory rules and restore native permission mode on every setup path. | implement | G2, C2, O9, O11 | Real guarded mutation or legacy reload bypasses the host request. |
| D5 | 2026-10-25 | Expose the inherited-Code-Mode child limitation in configuration help/docs and retain explicit developer-only child delegation as the verified alternative. Do not patch the system-owned binary or certify the combination. | diagnose | G2, O9, O13 | A later runtime exposes the child final-output tool and passes the full combination check. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                            | From     | Why still open                                                                                                                                                                      | Next action                                                                                                                                                               | Status |
| --- | --------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Account-free official-runtime acceptance is complete.                                               | V4, V7   | Official binary and production adapter/sandbox ran successfully.                                                                                                                    | Keep authenticated certification separate.                                                                                                                                | closed |
| X2  | Missing child metadata/custom-event and control wiring is repaired.                                 | V6, R2   | Regression tests and real native-child recovery passed.                                                                                                                             | Retain V9's distinct UI limit.                                                                                                                                            | closed |
| X3  | Authenticated provider pricing, cache savings and cross-provider billing are unmeasured.            | V7, R3   | Local fixtures prove request shape/transport, not real billing or latency benefit.                                                                                                  | Run an explicitly authorized real-provider evaluation before certifying 1.56.0; keep catalog consent.                                                                     | open   |
| X4  | Native child/status/import UI and a physical paired Host UI remain unverified.                      | V9       | macOS native screen is locked; only browser settings and RTL/remote-service fixtures were available.                                                                                | Run the actual Tauri and paired-device flows when an unlocked environment is available.                                                                                   | open   |
| X5  | Global lint and an existing selector test fail outside this change.                                 | V11      | Current shared tree has an unrelated lint warning and an unchanged OpenCode selector mismatch; final full typecheck passed.                                                         | Owners repair those paths; rerun global gates. No broad cleanup or unrelated fixes in this task.                                                                          | open   |
| X6  | Linux/Windows hosting and native production packaging are not established by this macOS run.        | R4, V11  | Web production build passes (129 static pages). Linux was not run; Windows mandatory sandbox remains unsupported; native Tauri test/package and desktop UI acceptance are separate. | Run Linux acceptance and native packaging; resolve the lint gate before PR delivery and do not add a Windows platform claim.                                              | open   |
| X7  | Goose 1.56.0 inherited-Code-Mode children cannot complete through their required final-output tool. | V12, O13 | This tool is absent both from the native model surface and callable Code Mode catalog in the tested binary. Resume cannot change an existing child's extensions.                    | Delegate new children with extensions:[developer] while keeping Code Mode on the parent; obtain an upstream runtime fix before claiming complete inherited-child support. | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                           | How / when measured                                                                   | Result                                                                                                                                             | Status  |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | User receives corrected prose and a traceable support matrix.                    | Compare report below with all supplied release bullets, 2026-10-25.                   | Each supplied theme has a correction and support classification; native-runtime acceptance remains separate.                                       | met     |
| M2  | Audited Cognia integration gaps become usable through existing local/Host paths. | Behavioral suites, official-runtime smoke and browser configuration flow, 2026-10-25. | Child inspection/recovery, concurrency/Code Mode settings, custom events, passive history and private state implemented; scoped acceptance passes. | met     |
| M3  | Full native UI and authenticated cross-provider operation are accepted.          | Separate real-environment acceptance.                                                 | Not measured in this task; X3/X4/X6 carried explicitly.                                                                                            | pending |

## Initial audit scope and method (before G2)

This is an audit of the current working tree on `dev`, observed HEAD `98c61ed8e4036fb782e0ac53654e3c6517a93f02` (2026-10-25, Asia/Shanghai). The checkout contains extensive concurrent edits, including external-runtime code; findings describe those inspected files rather than a clean commit or shipped Cognia release. No product code, catalog certification, credentials or installation was changed. A new Goose-specific ledger was needed because no existing Goose ledger was present under `docs/evidence/`.

CodeGraph exploration returned no index; literal searches and owning-source reads were used instead. Headless checks use production modules with synthetic inputs. The probe was stored under `.cache/goose-v156-audit/probe.ts`; cache cleanup may remove it. Primary sources below make the source findings independently traceable.

## Release proofreading

1. **Release time is correct.** `2026-10-23T15:49:34Z` is **2026-10-23 23:49:34 +08:00**, in both Singapore and Shanghai. The release is neither draft nor prerelease. This does not establish that every binary asset was available at that exact second.
2. **Resume has a specific scope.** The parent calls `delegate(resume: "<child-id>")`, optionally with `instructions`, to continue its own failed/cancelled child from saved conversation. Completed children and children belonging to another parent are rejected. Resume cannot be combined with source, model, provider or other creation options. This is not automatic retry or an exactly-once side-effect guarantee. [PR #13015](https://github.com/aaif-goose/goose/pull/13015).
3. **Concurrency is per parent.** `GOOSE_MAX_CONCURRENT_SUBAGENTS` accepts a positive integer, defaults to **5**, and queues excess children. Invalid/unset values use 5. Stopping the parent cancels running and waiting children. The standalone `goose-agent` GDK operation retains an unlimited default unless its host calls `with_max_concurrency`. [PR #12946](https://github.com/aaif-goose/goose/pull/12946).
4. **Links are native UI navigation.** Goose Desktop exposes read-only child sessions with a manual **Load latest progress** action. This is not a public/shareable URL or a live streaming child dashboard. The PR explicitly leaves a separate result-delivery bug outside its scope. [PR #12998](https://github.com/aaif-goose/goose/pull/12998).
5. **Boa changes the execution interface.** The PCTX/Deno/V8 implementation is replaced with Boa; discovery remains `list_functions` / `get_function_details`, execution becomes `execute_javascript` with `async function run()` and `tools.call(exactName, arguments)`. TypeScript generation, disclosure configuration and Code Mode's `execute_bash` are removed. Saved TypeScript calls remain displayable. Fresh contexts do not retain state; direct filesystem, shell, network, environment and package access are unavailable. Tools remain behind Goose's permission/lease/mutation flow. The runtime has its own four-worker global bound, separate from Subagent concurrency. [PR #12952](https://github.com/aaif-goose/goose/pull/12952), [tagged Code Mode guide](https://github.com/aaif-goose/goose/blob/v1.56.0/documentation/docs/guides/managing-tools/code-mode.md).
6. **Compaction wording should be narrower.** This is a context-freeze/kickoff visibility and request-window fix, not a blanket guarantee that all message-retention defects are fixed. The PR discussion explains the preserved-message visibility problem; the final patch adds a fallback to an agent-visible kickoff. It also emits a Goose-specific status notice for `HistoryReplaced`. [PR #12692](https://github.com/aaif-goose/goose/pull/12692/files).
7. **Caching is provider behavior.** Responses requests use a session-derived `prompt_cache_key` while preserving explicit overrides. Provider definitions can override cache-read and cache-write prices independently, preserving explicit zero and catalog fallbacks. This is not a measured latency/cost improvement for Cognia. [PR #12420](https://github.com/aaif-goose/goose/pull/12420), [PR #12944](https://github.com/aaif-goose/goose/pull/12944).
8. **MCP/Skills/GDK need precise names.** Unsafe or overlong public tool names receive a sanitized/truncated name plus a stable hash; dispatch still targets the original server tool. Skills discovery and foreground-child operations move into GDK. These are upstream implementation changes, not evidence that Cognia embeds GDK. Also relevant to ACP clients are the live catalog initializer fix for the standalone `goose-acp` binary, preserved model ordering, and recipe-extension loading for commands/delegation. [PR #12875](https://github.com/aaif-goose/goose/pull/12875), [PR #12935](https://github.com/aaif-goose/goose/pull/12935), [PR #12792](https://github.com/aaif-goose/goose/pull/12792), [release notes](https://github.com/aaif-goose/goose/releases/tag/v1.56.0).

The supplied warning that the whole release is not explicitly labeled breaking is consistent with the release notes. However, **the Code Mode API migration above is a concrete compatibility change**; describe that directly rather than implying only unusual JavaScript edge cases need regression. GDK embedders also need the changed `SubagentRunner::requested_subagent_session_ids` signature from PR #13015. Cognia's current path is external ACP and does not embed that Rust GDK API.

## Initial Cognia support matrix (superseded by implementation below)

| Area                     | Current evidence                                                                                                                                                                            | Gap / implication                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base Goose support       | Executable native ACP preset; system-owned binary; `goose acp --with-builtin developer`; approval mapping, tools, session list/load/resume fallback, modes and model/config-option support. | Existing support is substantial. v1.56.0 is `supported-uncertified`; unattended certification remains 1.52.0. macOS/Linux are cataloged; Windows is not, regardless of upstream NSIS support.                                                   |
| Native child resume      | Parent can potentially use the upgraded Goose delegate tool when enabled. Generic Cognia `resumeSession` restores an ACP session.                                                           | No Goose-specific host child-resume control or v1.56.0 child-resume regression was found. Generic session resume does not certify native child recovery.                                                                                        |
| Native child concurrency | Explicit `GOOSE_MAX_CONCURRENT_SUBAGENTS` passes the Node env filter; Rust allows `GOOSE_`.                                                                                                 | Manually configurable without a new transport feature. No dedicated field or mapping from host `maxConcurrentSessions`/Team limits was found. Host limits do not bound children inside Goose.                                                   |
| Read-only child viewing  | Upstream ACP tool-response metadata contains `_meta.goose.subagentSessionId`.                                                                                                               | Cognia caches `_meta` temporarily but omits it from emitted tool-result/update events. No Goose child-specific read-only navigator was found. Parent text still includes the ID; metadata loss does not erase that text.                        |
| Boa Code Mode            | The external Goose binary owns execution; Cognia's own Code presentation is a separate implementation. The preset explicitly enables developer, not Code Mode.                              | Do not claim the preset enables Boa by default or that Cognia must switch its own runtime. Enabling Goose Code Mode needs real discovery, JS execution, nested approvals, cancellation and output-limit regressions.                            |
| Context/compaction       | Upstream request-window fix runs inside an upgraded binary; generic ACP compaction support exists.                                                                                          | Client capabilities omit `_meta.goose.customNotifications`; `_goose/unstable/session/update` is ignored. Thus the new Goose-specific compaction notice is not surfaced. Standard preview compaction support does not fix this dialect mismatch. |
| Responses cache/pricing  | Existing standard ACP usage handling is present; upstream provider requests and price calculation run inside Goose.                                                                         | No new host caching implementation is justified by this release alone. Cache-key/provider billing accuracy through this integration is unverified.                                                                                              |
| MCP public names         | Goose profile recovers `_meta.goose.toolCall.toolName`; known `cognia-tools__` / `cognia-plugin-tools__` prefixes are mapped for host approval.                                             | Dotted/overlong/hashed aliases and collisions need exact identity/approval round-trip tests. This is a compatibility risk, not a reproduced permission bypass.                                                                                  |
| Skills / foreground GDK  | Native discovery operates in Goose; `.agents/skills` is a documented upstream root. Cognia uses the ACP package, as ADR-0217 intends.                                                       | No GDK embedding is required. No equivalence between Cognia's in-app skill selection and Goose filesystem discovery has been established; test intended skill roots and precedence.                                                             |

Two older gaps are separate from v1.56.0: the built-in transcript import registry has no Goose adapter (`lib/session-import/registry.ts`), and Goose has no per-configuration state-isolation rule (`protocol/external-agent-security-policy.json`; `launch-preparation.ts`). These do not mean ACP list/load is absent. `GOOSE_PATH_ROOT` configuration or Bot task-home isolation is not the same contract as Cognia's user-facing per-configuration isolation.

## Reproducible verification

```sh
pnpm test -- --runInBand --runTestsByPath \
  packages/agent-acp/src/vendors/goose.test.ts \
  packages/agent-acp/src/client.test.ts \
  lib/ai/agent/external/config/presets.test.ts \
  lib/ai/agent/external/config/install-catalog.test.ts \
  lib/ai/agent/external/config/runtime-version.test.ts
```

Result: **5 suites passed; 498 tests passed**. A follow-up `pnpm test -- --runInBand --runTestsByPath packages/agent-acp/src/feature-profile.test.ts cli/src/runtime/external/node-backend.test.ts lib/ai/agent/external/lifecycle/launch-preparation.test.ts` passed **3 suites, 86 tests**, with **1 existing skipped test**. Total: **8 suites passed; 584 tests passed; 1 skipped**. No coverage run. These include mocked protocol/approval/session contracts and pure catalog/version checks; they do not run Goose.

The production-module cache probe runs with `pnpm exec tsx .cache/goose-v156-audit/probe.ts`. It invokes `AcpClientAdapter.handleSessionUpdate` with a completed `delegate` tool result containing `_meta.goose.subagentSessionId="child-1"` and asserts the emitted `tool_result` omits that field. It invokes `notificationToEvent` with `_goose/unstable/session/update`, `sessionUpdate="status_message"`, `status={type:"notice",message:"Context compacted — earlier messages archived"}` and receives `null`. It also calls `assessRuntimeVersion` with output `goose 1.56.0` and `buildExternalAgentChildEnv({}, {GOOSE_MAX_CONCURRENT_SUBAGENTS:"2"})`.

```json
{
  "childMetadataDropped": true,
  "customStatusNoticeIgnored": true,
  "versionVerdict": "supported-uncertified",
  "certifiedVersions": ["1.52.0"],
  "concurrencyEnvironmentPreserved": "2"
}
```

This probe bypasses transport to isolate projection/filter behavior; it is not a Goose handshake. The first attempt had an incorrect relative import and failed before execution; after correction all assertions passed. `pnpm` printed an engine warning for its Node v24.19.0 host versus the repository's >=26 requirement; the `pnpm exec tsx` process used Node v26.12.1. No claim is made about a complete repository build or all-platform validation.

## Initially recommended increment (authorized by G2)

1. Preserve typed Goose child-session metadata through canonical events, and implement a read-only child navigation path that cannot submit prompts to a child still owned by its parent.
2. Negotiate and map the specific Goose custom status dialect, including compaction notices, with fixtures from v1.56.0. Do not advertise support until the handler exists.
3. Add the optional per-parent concurrency setting/help, clearly separated from open-session/Team limits; keep the existing manual environment route.
4. Run official v1.56.0 acceptance: own failed/cancelled child resume, rejection of foreign/completed children, queued-child cancellation, read-only child reload, Boa nested approvals/cancellation, MCP safe aliases and provider usage. Only then consider certification.

The initial audit did not change product code or certification. G2 authorized the implementation recorded below. Certification remains unchanged, and the ledger stays `verifying` for the explicit real-environment/global-gate residuals.

## Implementation follow-up (2026-10-25)

User: 完整的补全差异

The follow-up authorizes implementation and isolated official-runtime verification. C1's audit-only boundary is historical and superseded for this phase. Preserve unrelated concurrent edits; do not change certification without matching real acceptance evidence. No commit/push is requested.

Acceptance sequence (implementation / verification):

1. Preserve native child identity and Goose status/usage updates through adapter → canonical events → existing UI. Verify tagged fixtures, malformed inputs and other vendors.
2. Provide read-only child inspection with manual reload and parent-only recovery; reject foreign/completed children and bypass of the parent permission/PII path. Verify behavioral unit/integration tests and browser UI.
3. Expose per-parent concurrency and opt-in Code Mode configuration through the existing process configuration. Verify config serialization, positive integers, launch environment and default behavior.
4. Exercise Boa discovery/execution, nested approvals/cancellation, safe MCP aliases, Skills discovery, cache usage and model controls through official v1.56.0. Use isolated fixture state and a local deterministic provider where possible.
5. Complete existing Goose history-import and per-config isolation gaps using owning registries and real upstream formats. Evaluate Windows against the existing sandbox contract rather than just adding a platform string.
6. Run focused tests, i18n build/check/lint, typecheck, lint/static-export and applicable native/contract gates; inspect browser/native flow and final task diff. Retain actual environment blockers as residuals.

### Implemented behavior

| Area                  | Current implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Child observation     | Typed `nativeSubagent` metadata survives start/intermediate/result projection and persisted tool parts. Delegate details open an escaped read-only export with manual reload. Owner identity includes agent, parent, child and Host revision; stale async completions cannot populate a new owner.                                                                                                                                                                       |
| Child recovery        | Session operations list native child IDs and inspect exports. Recovery rejects unknown parents, foreign/completed children and busy parents, gates the full saved child conversation, and submits only through the parent's ordinary prompt callback. Gateway and paired-Host facades resolve the owning native session; remote recovery is an approved mutation. No child `session/load` or child prompt is used for inspection.                                        |
| Runtime configuration | Shared create/edit controls set positive `GOOSE_MAX_CONCURRENT_SUBAGENTS` and opt-in `--with-builtin ...code_execution`, preserving existing args/env. Native child limits remain distinct from open-session/Team limits. Code Mode help explains the whole-batch approval boundary.                                                                                                                                                                                     |
| Notices and usage     | Client capabilities advertise the implemented Goose dialect. Status notices use existing notification UI; progress is text rather than invented percentages. Cumulative cost/context snapshots avoid double-counting token deltas and preserve zero cost.                                                                                                                                                                                                                |
| Approval              | `requireApprovalFor` forces review of opaque Goose JS batches before wildcard auto-approval. Native mode is held at approve with mandatory rules. New/load/resume reapply the intended mode and fail closed if restoration fails. Real legacy-auto load/rejection passed.                                                                                                                                                                                                |
| State isolation       | Shared security policy, CLI and Rust backends map `GOOSE_PATH_ROOT`, override caller roots, force `GOOSE_DISABLE_KEYRING=1` and keep temp inside the private root. Shared roots are denied. Resolved absolute Goose executables work. Existing shared configurations retain their state.                                                                                                                                                                                 |
| History               | Register the Goose JSON source and desktop SQLite reader. Preserve tools/errors/reasoning/images/usage and parent links; hide `userVisible=false` and audience-restricted text/images/tool results. Corrupt visibility/content yields an explicit diagnostic/error. SQLite uses read-only access, preflight row counts and stable message ordering; session IDs/parents are scoped by store. Imported sessions remain archives without a fabricated live resume binding. |
| Runtime-owned changes | Boa execution, compaction request-window behavior, provider cache keys/prices, MCP alias construction and Skills discovery remain in Goose. The adapter preserves their interfaces; it does not duplicate GDK or replace Cognia's own JavaScript runtime.                                                                                                                                                                                                                |

New modules were necessary because generic ACP session loading can start runs and supplies no passive Goose export contract. `goose-session.ts` owns that bounded vendor contract; `goose-session-controls.tsx` shares a read-only viewer between tool details and session operations; `goose-runtime-fields.tsx` shares one serializer across create/edit surfaces. Goose's native Session envelope, audience annotations and archive-only semantics need their own source adapter rather than treating raw export JSON as portable messages. The new smoke entry extends the existing bundle runner with deterministic 1.56-specific runtime obligations.

### Final verification record

- Official release asset: macOS arm64 `goose.tar.gz`, SHA256 `52f3f8d62e3d144c5de70c5c471de39d8b92c24d41d5b3436eb8bab11ba4bc24`; extracted version `goose 1.56.0`. Archive digest matched before extraction; only the replaceable downloaded archive was later removed during disk pressure. The binary, raw fixture requests, private session data and logs remain under `.cache/goose-v156-implementation/`.
- Reproduction: `PATH="$PWD/.cache/goose-v156-implementation:$PATH" pnpm exec node scripts/smoke/build-and-run-smoke.mjs --goose-v156`. Production Cognia adapter and mandatory sandbox; loopback HTTP provider/MCP fixtures and synthetic credentials; no production account inference.
- `smoke-versioned-final.log`: exit 0, 51 provider requests including title requests. Two foreground Responses turns retained `prompt_cache_key=session.id`; native Skills reached the prompt; dotted, colliding sanitized names and an overlong tool dispatched to all three original MCP names with three host approvals. Parent concurrency configured 1, observed peak 1 for two completed delegates. Failed/cancelled recovery and completed refusal passed.
- Boa checks: `list_functions`/`get_function_details`, arithmetic 42, absent `process`/`require`, nested file mutation, rejection preserving original file, cancellation of a slow callback with the session remaining responsive, bounded million-character return. Approval applies to the outer batch. Saved native-auto reload with mandatory rules surfaced approval and rejection preserved the file. Early fixture attempts failed on final-output schema, MCP discovery fallback and strict Responses SSE fields; those fixture defects were corrected without weakening the product invariants.
- Focused Jest aggregate: `focused-final.log` — **23/24 suites passed; 1268 passed, 1 failed**. Sole failure: unchanged `does not offer the retired OpenCode V1 protocol as a selectable option` at `connection-fields.test.tsx:130`. The protocol options implementation has no task diff; its source derives the option from the existing executable protocol set. The new Goose connection/editor/recovery tests pass. Added history error-path check: **4/4 passed** (`history-errors-final.log`). No coverage command run.
- Native: `cargo test -p cognia-agent-state public_goose_reader -- --nocapture` — **1/1 passed**, including ordered native rows, parent/model, byte-identical DB and corrupt content/metadata errors. `cargo test -p cognia-external-agent goose -- --nocapture` — **5/5 passed**, including absolute executable/private temp/keyring and shared-root denial. Rust formatting was applied only to owned new functions, preserving concurrent changes.
- Passed: task-scoped ESLint with zero warnings; full `pnpm typecheck`; `pnpm build` (129/129 static pages, exit 0); `pnpm --filter @cognia/agent-acp typecheck`; independently run `pnpm sidecar:typecheck`; `pnpm i18n:build`, `i18n:build:check`, `i18n:sort:check`, `lint:i18n`; `lint:static-export` (11704 TS files); `audit:agent-capabilities`. Formatting, ledger and task diff checks are recorded after the final documentation update.
- Final full `pnpm typecheck` exits 0, including root and all sidecar phases (`typecheck-last.log`). Earlier shared-tree runs reported an unrelated CLI test type error and then `bottom-toolbar.tsx:263`; those failures are superseded by the final passing run. Global `pnpm lint` still fails on an unused `extra` argument warning in `lib/platform/host-feature-manifest.test.ts:902` (`lint-final.log`). That file was not modified by this task; task-scoped ESLint passes.
- Real browser: Goose add form displayed max concurrency and Code Mode; entering 2 and toggling Code Mode produced `acp --with-builtin developer,code_execution`. Screenshot and AX state inspected; unsaved draft cancelled. The task-owned dev server was stopped. Child viewer/parent callbacks/Host revision reset are behaviorally tested in RTL. Native screen was locked, so no native Tauri UI, physical paired Host, complete Tauri test/build or native production packaging claim is made.
- Independent reviewers: i18n/test wiring, PII, native/Rust, history/isolation and final test-gap review. Repaired findings: session-scoped facade lookup; full child recovery PII context; owner/revision reset; per-block audience filtering; malformed metadata/content; preflight row bounds; store-scoped IDs; isolated absolute-binary temp; mandatory batch and legacy mode restoration. No unaddressed reviewer blocker remains in the Goose-owned code.

The catalog retains certification at 1.52.0 and identity-bound consent for 1.56.0; its note now points to the bounded official-binary evidence. Linux and authenticated cross-provider billing remain unverified, and Windows is not added to a platform catalog whose mandatory sandbox cannot host it. No commit, push, credential migration or unrelated cleanup was performed.

The final official-runtime run also pins the inherited-Code-Mode child limitation and verifies a developer-only child of a Code Mode parent. Its report contains `knownLimitations.inheritedCodeModeChildFinalOutputUnavailable=true` and `codeModeParentDeveloperChildRecovery=true`; it does not convert the failing combination into a success claim. The viewer/recovery extension is available only after initialization identifies a stable Goose v1 version >=1.56.0. Unknown, older and future-major versions retain base ACP without this extension. Version-guard red run failed four cases, then the client/helper suites passed 400 tests.

Final build result: `pnpm build` exits 0 (`build-final.log`), webpack compiled successfully in 6.8 minutes and all 129 static pages were generated. The normal prebuild also refreshed its derived support-doc catalog and sidecar bundles. Task formatting and diff whitespace checks pass; final ledger check reports zero errors and warnings. No task smoke or dev-server process remains running.
