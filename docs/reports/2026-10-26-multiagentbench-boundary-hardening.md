# MultiAgentBench boundary hardening and DS smoke

Date: 2026-10-26. Fixed all five CLI findings F1–F5, four API-boundary findings A1–A4, and the contradictory diagnostic format contract in the [retained review](2026-10-26-multiagentbench-repair-adversarial-review.md). The solver graph remains research-text-v1. Artifact validation and judging are separately versioned as v3; historical campaigns and grades are unchanged.

## Repair disposition

| Finding | Implemented behavior                                                                                                                                                                                | Regression evidence                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| F1      | Validate complete recovered samples/trials, finite nonnegative metrics and both derived projections before importing salvage or repairing a torn tail. Reject without changing journal or snapshot. | Runner rejecting-preservation cases; sample/trial validation tests.                                                            |
| F2      | Independently enforce CLI types/bounds on frozen options and compare every derived manifest field before opening storage or reading credentials. Reject live/dry contradictions.                    | Model mismatch, invalid timeout, dry-run contradiction, negative budget and oversized judge cap cases.                         |
| F3      | Match phase, agentId, taskId and judgmentKind to admission; reject globally reused call IDs.                                                                                                        | All four identity mismatch cases.                                                                                              |
| F4      | Decode acknowledged UTF-8 strictly, validate semantics first, and preserve original Buffer bytes during tail repair.                                                                                | Binary interior corruption and semantic rejection preserve bytes and create no tail repair.                                    |
| F5      | Preserve the exact gated research proposal as visibleProposal after the final deep PII check; verify quotes against it.                                                                             | Actual target + actual PII gate with different emails in rubric/proposal validates the EMAIL_002 quote.                        |
| A1      | Latch journal stat failures before any queued append or next disk admission.                                                                                                                        | First stat EIO rejects both queued writes and subsequent admission.                                                            |
| A2      | Terminal/idempotent close, serialized owned operations, shutdown-aborted waits and exact owner-nonce check. Closed predecessors cannot write or clean successors.                                   | Failed predecessor cleanup, successor reserve, repeated close and stale method calls.                                          |
| A3      | Invocation-owned evidence abort signal and post-await checks stop admissions already waiting when another hook fails.                                                                               | Actual private scheduler with two waiting hooks, no caller abort and zero provider dispatch.                                   |
| A4      | Retain returned solver/judge samples before awaited settlement persistence. Preserve known partial accounting.                                                                                      | Settlement rejection retains the sample and tokens; invalid provider counts retain valid components with partial availability. |
| Format  | Communication gets its rating-object schema; milestones get only their bounded array/identity schema and matching instructions.                                                                     | Actual generated prompt assertions plus the eight attempted real judgments below.                                              |

The new Node-only validation module separates externally recovered data schemas from runner I/O and reuses existing research parsers. It is reached by both fresh execution and frozen resume. No Node dependency was added to the static-export app. Current launcher recovery requires v3; pre-v3 artifacts retain their original frozen runner and documented recovery procedure, with no migration or rewrite.

## Verification

Node v26.12.1 on Apple Silicon. Exact logs and receipts: `.cache/multiagentbench-hardening-2026-10-26/`.

- Behavioral red runs: storage4 failing cases, recovery10, runtime5 and model observer1; a further preflight cancellation counterexample failed before its correction. Retained logs: storage-red.log, recovery-red.log, runtime-red.log, model-red.log and cancel-red.log.
- `pnpm test -- scripts/eval lib/ai/eval --runInBand`: **67 suites / 622 tests passed**. After two test-only type corrections, the affected runtime/model suites passed again:2 suites /34 tests.
- The real serial Markdown quote mismatch also has a regression: exact raw text passes, omitting literal `**` is rejected; no rendering-normalization fallback was added.
- `node --test scripts/eval/multiagentbench.test.mjs`: **8 tests passed**.
- Full `pnpm lint`: exit0. Scoped Prettier check: exit0. Static-export gate:11,730 TS files audited, no forbidden Node imports. `pnpm sidecar:typecheck`: exit0 for all configured sidecar checks.
- Full `pnpm typecheck`: exit2, **8 diagnostics outside owned paths**: four in hooks/chat/use-claude-chat.test.ts; four ES2018/BigInt diagnostics in lib/connectors/adapters/discord/avatar.ts and its test. No owned source/test diagnostics remain. Other owners’ files were preserved.
- PII, co-located-test and wiring preflight auditors rechecked clear. They found one intermediate integration regression: cancellation after durable admission must allow a failed trial with unknown call liability. Its real runtime/team regression reproduced red, then passed after removing the overstrict guard. Unknown liability remains explicit and is never discharged by a failed trial alone.
- Actual benchmark runtime build succeeded; 6290 compiler inputs and 2514 output hashes retained. All six owned production files match the actual loaded compiler inputs. Full main-app build, UI/native acceptance and coverage were outside this headless change; no such pass is claimed.

## Real DS Flash smoke

One public task1, five source roles, one repetition per mode; all diagnostics enabled. Solver and judge both use ark-deepseek-v4.1-flash via the authorized localhost proxy. Solver ceiling8192, judge ceiling16384, independent judge deadline180s; solver deadline1800s. Frozen execution order was single, parallel, serial. No quality retries.

| Mode           | Primary rating / 5 | Completion | Solver s | Judge s | Total trial s | Solver tokens | Judge tokens |
| -------------- | -----------------: | ---------- | -------: | ------: | ------------: | ------------: | -----------: |
| single-agent   |              3.333 | 1/1        |   37.690 |  50.582 |        88.360 |         6,721 |        8,882 |
| serial-squad   |           ungraded | 1/1        |  181.780 |  34.293 |       216.167 |        27,249 |       25,552 |
| parallel-squad |              3.000 | 1/1        |   84.572 |  93.723 |       178.378 |        26,968 |       21,209 |

All3 solver trials completed and all3 five-question structure checks passed. Primary research assessments parsed in **2/3** trials and **7/8 applicable judgments graded**. The serial primary assessment omitted the proposal’s literal Markdown bold delimiters from one feasibility quote, so the strict verbatim parser correctly rejected it; its raw answer and all usage remain recorded. No fallback grade or quality retry was used. The single-Agent communication diagnostic is inapplicable. All21 admitted calls settled with known usage; total captured tokens **116,581**, unknown call liabilities0. Token totals include input+output; cache counts remain separate metadata and are not added twice. Currency cost remains unavailable because the internal channel rates were not supplied.

Solver time is the trial’s wall clock, including concurrent member execution; judge time sums sequential judge calls. Total trial time runs from durable attempt admission to trial settlement and includes judging/I/O, excluding runtime build. Ratings are an uncalibrated same-model judgment on one introduction. This is integration smoke, not a new100-task effectiveness campaign or evidence of general mode superiority.

The residual reliability issue is model compliance with exact quotations: the serial proposal contains `The proposed framework is **DP-PDRD: ... Learning**.` while the response omits `**`. The quote is142 characters and the reason435 characters, so this was neither truncation nor a bound violation. The v3 prompt conflict and redaction representation defects are fixed; free-text compliance is still imperfect and requires a separately declared protocol experiment if a different evidence-selection mechanism is desired. This smoke does not establish a zero-invalid-judgment rate.

## Release and evidence preservation

Main smoke and hash-verified completed resume both exited1 because one primary judgment remains invalid. This is a retained judge-compliance failure, not an execution crash or repair/replay failure. Completed resume left events.ndjson and results.json byte-identical and admitted zero additional model calls. The task-owned process chain exited; runner lock, emergency reserve and temporary next files are absent. The build service was stopped before inference. This closed-book host allocated no VM/native workspace. Evidence and the shared user-supplied proxy are retained.

Resource and replay receipts: resource-release.json, resume-receipt.json, executed-source.json, historical-integrity.json and comparison.json under the evidence root. All11 protected files from the historical100-task campaign remain byte-identical. No commit or push was performed.
