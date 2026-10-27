# Evidence ledger: Copilot CLI current-release support

- Status: verifying
- Lane: standard
- Created: 2026-10-23
- Updated: 2026-10-24
- Related: ADR-0062; ADR-0217; GitHub Copilot CLI ACP reference

## Original request

> 检查一下目前Cognia怼Copilot CLI的支持情况

Follow-up, 2026-10-23:

> 继续，补齐对最新版 Copilot CLI 的支持，用 Node 26 做真实 ACP 链路和历史导入验证，发现的问题直接修复。

## Knowledge

| ID  | Statement                                                                                                                              | State    | Basis                                                                                                                                                               | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Assess current support, repair current-release incompatibilities and verify real ACP and history import under Node 26.                 | Agreed   | Original request and follow-up, 2026-10-23.                                                                                                                         | -          |
| C1  | Preserve concurrent work; isolate CLI installation, workspace, credentials and Copilot home; do not commit or change the user's login. | Verified | Shared dirty checkout and task scope, 2026-10-24.                                                                                                                   | G1         |
| O1  | Cognia already has a runnable Copilot ACP preset, governed host process bridge, BYOK gateway and registered portable history source.   | Verified | ecosystem-adapters.ts, config/presets.ts, integrations/acp.ts, manager.ts, gateway-task.ts, session-import/registry.ts; source traced 2026-10-23.                   | -          |
| O2  | Latest stable Copilot CLI is 1.0.103; ACP is public preview, defaults to stdio and supports BYOK.                                      | Verified | Official release page marked Latest and ACP reference re-read 2026-10-24; real initialize reports 1.0.103.                                                          | -          |
| O3  | Node 26.12.1 and task-local Copilot 1.0.103 execute through Cognia's actual Node host and ACP adapter.                                 | Verified | report.json and github-report.json, 2026-10-24; both ok=true.                                                                                                       | O1, O2     |
| O4  | Copilot reports URI mode IDs, separate allow_all on/off, and legacy copilot-login terminal-auth metadata.                              | Verified | Real initialize/session responses, initial failing smoke, current live acceptance and co-located regressions, 2026-10-23/24.                                        | O3         |
| O5  | The current CLI rejects ACP client-supplied stdio MCP servers and accepts HTTP MCP servers.                                            | Verified | Native warning: Rejecting non-http/sse MCP server "cognia-smoke" from client. Final HTTP tool invocation and returned marker pass through real Copilot, 2026-10-24. | O3         |
| O6  | Current events.jsonl import lost the selected model and retained an old verification date.                                             | Verified | Captured transcript regression first failed with missing model and verifiedAt 2026-08-29; fixed regression and real import now pass.                                | O3         |
| O7  | Authenticated native GitHub model requests, persisted history scan and cross-process resume pass on macOS.                             | Verified | github-report.json: 6 initial text deltas, 4 resumed deltas, 4 imported messages / 25 persisted events; 2026-10-24.                                                 | O3         |
| O8  | A live DeepSeek BYOK request reaches the provider but receives 402 Insufficient Balance.                                               | Observed | live-report.json, 2026-10-23. No successful DeepSeek completion is claimed.                                                                                         | O3         |
| O9  | Full lint passes; root typecheck has three errors outside this task; full static-export gate overflows its git-output buffer.          | Observed | lint.log exit 0, typecheck.log exit 2, static-export.log ENOBUFS; 2026-10-24.                                                                                       | -          |

## Problem frame

Complete the existing ACP integration against the latest release (G1), using real process traffic and persisted artifacts as the compatibility contract. Retain the host permission broker and existing protocol abstraction. A passing deterministic provider run establishes tool/lifecycle behavior; a separate authenticated GitHub run establishes a real model path. Neither establishes rendered Tauri or paired-mobile acceptance.

Acceptance sequence was recorded before implementation:

1. Pin the official CLI under Node 26, in task-local storage and a disposable workspace/Copilot home; verify version and process cleanup.
2. Exercise initialize, session creation, streamed text, config/mode projection, approved and rejected tools, HTTP MCP, cancellation/recovery, close/list and cross-process load/resume using Cognia's actual adapter and host.
3. Import actual persisted events through the production source, including filesystem discovery, identity, model, messages, tool results and native resume binding; retain a sanitized upstream fixture.
4. Repair defects at their existing owners with co-located tests and preserve other vendors/import sources.
5. Run focused and adjacent tests on Node 26, applicable build/type/lint/gates, independent review and final ledger/diff checks. Record blockers precisely.

New-file rationale: existing vendor profiles have no Copilot owner, so the new pure Copilot profile and co-located test extend that registry. The real-process smoke belongs beside existing vendor smoke scripts; the sanitized transcript belongs in the existing upstream fixture directory. A changeset records the user-facing fixes.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                        |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------ |
| scale        | medium | Vendor profile, common ACP state projection, history normalization and smoke infrastructure.                       |
| technical    | medium | Native mode/auth/MCP contracts differ from generic ACP assumptions. Real-process probes resolve those differences. |
| coupling     | medium | Shared adapter and portable source require adjacent-vendor regressions.                                            |
| requirement  | low    | Existing route, latest version, Node 26, real ACP/history verification and repairs.                                |
| verification | medium | Real Node host and GitHub provider are available; rendered desktop/paired platforms are outside measured coverage. |
| risk         | medium | Permission projection, trusted login arguments and imported provenance must remain truthful.                       |

## Risks

| ID  | Risk (impact)                                                                            | Severity | Source                                | Claim                                                                                                     | Refuted by                                                                                                           |
| --- | ---------------------------------------------------------------------------------------- | -------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| R1  | URI modes or sticky native bypass can misstate host approval policy.                     | high     | Real protocol; independent reviewers. | Keep native behavior and host-selected authority separate; restore host approvals before applying policy. | Native on/off leaves dontAsk bypassed, Plan grants edits, or resume discards explicit host policy.                   |
| R2  | Agent-provided login metadata or a wrapped launcher can execute the wrong command.       | high     | Credential/process catalog.           | Only trusted copilot-login maps to configured direct executable plus fixed login arguments.               | Metadata command/arguments execute, ACP flags enter login, or wrapper prefix is silently dropped.                    |
| R3  | Silent MCP rejection can make configured tools unavailable without explanation.          | medium   | Real native MCP warning.              | Fail fast for client stdio MCP and retain HTTP/SSE configuration support.                                 | Unsupported stdio is sent or the tested HTTP tool/result is absent.                                                  |
| R4  | Latest history import can lose model/tools or invent resume fidelity for child sessions. | medium   | Real transcript regression.           | Preserve main model/provenance/tools and keep synthetic subagent children archive-only.                   | Captured fixture loses fields, children contaminate parent model, or synthetic child receives native resume binding. |
| R5  | Shared abstractions or mock-only checks can conceal regressions and shell gaps.          | medium   | Shared tree; verification catalog.    | Separate unit, real-process, real-provider and untested shell evidence.                                   | Blanket acceptance claim, unrelated edits, or stale fixtures presented as current real transcripts.                  |

## Verification obligations

| ID  | Risk           | Method                                                                                  | Independence   | Evidence                                                                                                                                                                                                                                  | Coverage                                                                                                                                                             | Status  |
| --- | -------------- | --------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2, R3, R4 | Co-located regressions plus adjacent preset/gateway/manager/import suites on Node 26.   | tool           | acceptance-tests.log: 22 suites, 1,211 tests and 1 snapshot passed; regression-tests.log: 8 suites / 417 tests passed.                                                                                                                    | ACP client, profiles, gateway configuration, manager, history, registry and plugin interchange. No coverage run.                                                     | passed  |
| V2  | R1, R3, R4, R5 | Real Copilot through actual Cognia adapter/CLI host with loopback provider.             | real-env       | report.json ok=true on Node v26.12.1 / Copilot 1.0.103; 15 imported messages / 62 persisted events, filesystemScan=true.                                                                                                                  | Streaming, Plan/Agent, allow_all reset, approval/rejection, HTTP MCP result, cancel/recovery, close/list and cross-process resume. Deterministic provider, real CLI. | passed  |
| V3  | R2, R4, R5     | Authenticated native GitHub provider run through the same production path.              | real-env       | github-report.json ok=true; streamed COPILOT_SMOKE_OK and RESUMED_OK, 4 messages / 25 events imported, native binding and filesystem scan.                                                                                                | Existing gh credential read only in explicit lane; no repository content sent. Browser/device-code login and provider-selected tools not exercised.                  | passed  |
| V4  | R4             | Import captured current-version artifact; confirm initial failure and corrected result. | tool           | history-red.log: missing model and stale verifiedAt; copilot-cli.test.ts and current generation gate now parse copilot-1.0.103-events.jsonl successfully.                                                                                 | Real artifact text/model/tool success/tool denial/resume; synthetic child model and archive-only regressions remain separately labeled.                              | passed  |
| V5  | R1, R2, R5     | Independent risk review and applicable preflight auditors.                              | fresh-reviewer | Risk reviewer, PII auditor, test-gap auditor and wiring auditor completed. Their sticky-bypass, resume-policy, wrapped-login and fixture-overclaim findings were fixed; test-gap and wiring re-review report no remaining blockers.       | Source/diff and tests; wiring reviewer also independently executed an in-memory policy/MCP/login probe.                                                              | passed  |
| V6  | R5             | Package typecheck/build; root lint, i18n, capability and co-location gates.             | tool           | @cognia/agent-acp typecheck and build exit 0; pnpm lint exit 0; lint:i18n, i18n:sort:check, audit:agent-capabilities and audit:colocated-tests exit 0.                                                                                    | Current checkout. No full production build, native packaging or coverage.                                                                                            | passed  |
| V7  | R5             | Full root typecheck and static-export gate.                                             | tool           | typecheck.log: three unrelated diagnostics listed below. static-export.log: git ls-files exceeds default execSync maxBuffer, ENOBUFS. Same exported scanner on all seven changed production files returns zero violations/bad exemptions. | Root checks attempted; scoped static scan passes, full checks not green.                                                                                             | failed  |
| V8  | R2, R5         | Successful live BYOK provider completion in addition to native GitHub.                  | real-env       | DeepSeek API returned 402 Insufficient Balance. Loopback OpenAI-completions BYOK works; native GitHub live passes independently.                                                                                                          | The direct CLI BYOK wire path is exercised; successful real DeepSeek and the entire Cognia gateway HTTP server path remain unaccepted.                               | blocked |
| V9  | R5             | Final formatting, explicit-path diff review, ledger validation and process cleanup.     | tool           | Final review/check record below; task-local process scan found no remaining Copilot processes.                                                                                                                                            | Owned files only; concurrent unrelated changes preserved.                                                                                                            | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                                                                  | Action     | Based on       | Reversal trigger                                                                                      |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | 2026-10-23 | Initial read-only audit found a wired generic ACP route but no latest-release real acceptance. Retain that implementation and gather real evidence.       | diagnose   | G1, O1         | New protocol/runtime evidence changes the compatibility route.                                        |
| D2  | 2026-10-23 | Follow-up authorizes isolated CLI installation and current-release repair; use real process probes and a deterministic provider before live acceptance.   | experiment | G1, C1, O1, O2 | Isolation fails or a host permission boundary cannot be preserved.                                    |
| D3  | 2026-10-23 | Add a declarative Copilot profile for URI modes, separate native approval switch and trusted legacy login.                                                | implement  | O4, C1         | Real supported mode/auth responses contradict the mapping.                                            |
| D4  | 2026-10-23 | Recover model and source-specific provenance at the current history owners; keep archive-only child bindings.                                             | implement  | O6, C1         | Captured artifact or child regression loses fidelity/resume safety.                                   |
| D5  | 2026-10-24 | Refuse ACP client stdio MCP with an actionable message and verify HTTP; do not introduce persistent MCP config writes or per-session process workarounds. | implement  | O5, C1         | Upstream accepts stdio through ACP or HTTP tool acceptance fails.                                     |
| D6  | 2026-10-24 | Retain host-selected policy independently of effective native bypass, and reject wrapped terminal login before spawning.                                  | harden     | O4, C1         | Notification/resume/cleanup regressions or independent review finds a remaining authority escalation. |

## Residual risks

| ID  | Residual                                                                                                             | From   | Why still open                                                                                                                                          | Next action                                                                                                                                                          | Status |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Full root typecheck and static-export gate are not green.                                                            | V7, R5 | Three diagnostics outside this scope; static gate output buffer overflows on the repository's tracked-file list.                                        | Owning sessions repair their files; separately increase static gate subprocess buffer or enumerate source files without buffering. Re-run full gates before release. | open   |
| X2  | Successful real DeepSeek BYOK completion and complete Cognia HTTP gateway acceptance remain unverified.              | V8, R2 | Provider account returns 402; loopback BYOK and native GitHub live cover different paths.                                                               | Restore provider balance or supply an already configured funded provider, then run the explicit live lane and a full gateway acceptance.                             | open   |
| X3  | Rendered Tauri/paired browser-mobile, Windows/Linux, SSE MCP and interactive device/browser login were not executed. | R5     | This task proves the real macOS Node process/ACP path; no native command, IPC payload, Tauri capability or sidecar-spawn implementation changed.        | Exercise those shells/transports before claiming their acceptance. The trusted terminal launch contract is unit-tested only.                                         | open   |
| X4  | Custom COPILOT_HOME automatic discovery remains unchanged.                                                           | R4     | Source scans the documented default ~/.copilot/session-state layout; manual file selection works. Smoke isolates that same layout in a disposable home. | Add an explicitly configured import root if custom-home discovery is required.                                                                                       | open   |

## Outcome

| ID  | Signal                                                                                                | How / when measured                                                       | Result                                                                                                                                     | Status |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| M1  | Evidence-backed support assessment.                                                                   | Initial audit, 2026-10-23.                                                | Existing preset/host/gateway/import route traced; 18 suites yielded 1,150 passing tests and one stale shared-date assertion under Node 24. | met    |
| M2  | Latest CLI works through real Cognia ACP and produces importable history under Node 26.               | Final loopback and authenticated native GitHub runs, 2026-10-24.          | Both ok=true; streaming/resume/history verified; deterministic real-process tool/MCP/cancel checks pass.                                   | met    |
| M3  | Discovered compatibility defects have regression protection without overstating remaining acceptance. | 22-suite test run, independent re-review and residual record, 2026-10-24. | Mode/login/import/MCP defects fixed, 1,211 tests pass, remaining gate/provider/shell limits explicit.                                      | met    |

## Implementation and evidence record

- Copilot profile maps canonical Plan to the native Plan URI, executable host policies to Agent, and never automatically selects Autopilot. A separate host policy prevents a transient native bypass from becoming sticky. Mode updates require acknowledged allow_all=off before claiming a host restriction.
- Exact trusted copilot-login becomes terminal auth. The configured direct executable runs with fixed login args, resolved environment and cwd. Agent-supplied executable/arguments are ignored. Wrapped launchers receive an actionable refusal instead of silently becoming node login.
- The native warning for client-supplied stdio MCP was reproduced across declaration variants. HTTP MCP initialize, tools/list, tools/call and marker propagation pass with the real CLI. SSE configuration remains permitted but is not live-tested here.
- Copilot history version is 1.0.103, verifiedAt 2026-10-23 (the capture date). Main model comes from main-session model changes or assistant metadata; child model stays separate. Portable sources accept an optional source-specific date while retaining the legacy default for unchanged sources.
- The checked-in 20-event fixture was captured from actual 1.0.103 output, then trimmed to relevant persisted events and pseudonymized. Session IDs and workspace paths are synthetic. Credentials, system prompts and unrelated user data are absent. Full local acceptance transcripts remain in ignored task cache.
- The current-generation fixture gate parses that captured JSONL. It no longer claims captured sqlite/checkpoint/background coverage. Pi's already-owned current version/date are reflected in the shared manifest; previous-generation evidence dates remain independent.
- Smoke runner installs the same CLI host branch as the production CLI before importing the real ACP integration. Generated output stays under .cache/copilot-cli-acceptance; only its dependency-resolution link points at cli/node_modules.

### Reproduction

Node binary: /Users/bytedance/.nvm/versions/node/v26.12.1/bin/node. The default pnpm launcher selected Node 24, so a task-local pnpm wrapper explicitly invokes Node 26 and the existing pnpm installation. All final test/check subprocesses use the following PATH.

```sh
export PATH="$PWD/.cache/copilot-cli-acceptance/bin:/Users/bytedance/.nvm/versions/node/v26.12.1/bin:$PWD/.cache/copilot-cli-acceptance/runtime/node_modules/.bin:$PATH"

# One-time task-local, pinned installation; no user's global CLI/config is changed.
rtk proxy npm install --prefix .cache/copilot-cli-acceptance/runtime \
  --no-save --package-lock=false --registry=https://registry.npmjs.org @github/copilot@1.0.103

rtk proxy node scripts/smoke/build-and-run-smoke.mjs --copilot-acp
rtk proxy node scripts/smoke/build-and-run-smoke.mjs --copilot-acp --github-auth
# Optional direct BYOK lane: currently returns provider 402.
rtk proxy node scripts/smoke/build-and-run-smoke.mjs --copilot-acp --live-provider

rtk proxy pnpm test -- --runInBand --runTestsByPath \
  lib/ai/agent/external/ecosystem-adapters.test.ts \
  lib/ai/agent/external/config/presets.test.ts \
  lib/ai/agent/external/config/install-catalog.test.ts \
  lib/ai/agent/external/config/gateway-task.test.ts \
  lib/session-import/adapters/copilot-cli.test.ts \
  lib/session-import/registry.test.ts \
  packages/agent-acp/src/client.test.ts \
  packages/agent-acp/src/registry.test.ts \
  components/agent/external-agent/add-agent/preset-catalog.test.ts \
  components/agent/external-agent/add-agent/preset-copy.test.ts \
  lib/agent-ecosystem/catalog.test.ts \
  lib/plugin/convert/platform-bundles.test.ts \
  lib/ai/agent/external/integrations/acp.test.ts \
  lib/ai/agent/external/manager.test.ts \
  lib/session-import/adapters/portable-agent-source.test.ts \
  lib/ai/agent/external/config/installed-runtimes.test.ts \
  lib/agent-ecosystem/runtime-catalog.test.ts \
  lib/subscription/limits/custom/presets.test.ts \
  packages/agent-acp/src/vendor-profile.test.ts \
  packages/agent-acp/src/vendor-profiles.test.ts \
  packages/agent-acp/src/vendors/copilot.test.ts \
  lib/session-import/fixtures/upstream-generations.test.ts

rtk proxy pnpm --filter @cognia/agent-acp typecheck
rtk proxy pnpm --filter @cognia/agent-acp build
rtk proxy env NODE_OPTIONS=--max-old-space-size=16384 pnpm lint
rtk proxy pnpm typecheck
rtk proxy pnpm lint:static-export
rtk proxy pnpm audit:colocated-tests
rtk proxy pnpm audit:agent-capabilities
rtk proxy pnpm lint:i18n
rtk proxy pnpm i18n:sort:check
```

The explicit GitHub lane reads the existing gh token into child environment only. It never logs/persists it and does not start a new login. Both successful runs use synthetic prompts and a disposable directory outside the checkout, separate COPILOT_HOME, disabled built-in MCPs and no auto-update. The loopback lane supplies synthetic BYOK credentials and placeholder GitHub tokens.

Observed final test output:

```text
Test Suites: 22 passed, 22 total
Tests:       1211 passed, 1211 total
Snapshots:   1 passed, 1 total
```

Observed full-root typecheck blockers:

```text
lib/claude/provider-attempt-options.ts(157,42): TS2339: Property 'protocol' does not exist ...
lib/connectors/adapters/qq-official/parse.ts(185,28): TS18048: 'dispatch.d' is possibly 'undefined'.
scripts/smoke/builtin-agent-budget-live.ts(594,44): TS2345: callback prior parameter is incompatible with Array.map index.
```

No diagnostic names a Copilot-owned file. These shared-tree files were not changed by this task. Full static-export gate fails with spawnSync /bin/sh ENOBUFS while capturing >1 MiB of git ls-files output; its exported scanner returns zero violations and zero bad exemptions on all seven changed production files (static-export-scoped.log). The gate implementation was not edited.

The first full lint attempt exhausted its default heap; a second attempt exposed task-generated bundles mistakenly placed under cli/.cache. Those task-owned bundles were removed and the runner output moved to the ignored root cache. Final full lint with a 16 GiB heap exits 0. Temporary ENOSPC/disk-I/O failures occurred before successful retries; no unrelated caches or worktrees were deleted.

No coverage run, full production static build, Tauri package/build, physical-device or paired-host acceptance was performed. UI/native login was not driven. Current known experimental localStorage and Three.js deprecation warnings in the CLI bundle do not fail acceptance. Existing manager tests emit handled mock teardown errors; actual process shutdown was separately verified.

### Final review

Owned production/test/smoke/fixture/changeset paths were reviewed explicitly. Package build/typecheck, full lint, 22 focused/adjacent suites and applicable gates have the results above. No task-local Copilot process remains after teardown. Formatting, diff whitespace and final ledger-check output are recorded in the task cache. The ledger stays verifying because residuals are open; it is not a full release-acceptance claim.

## Sources

- [GitHub Copilot CLI 1.0.103 release](https://github.com/github/copilot-cli/releases/tag/v1.0.103), marked Latest on 2026-10-24, released 2026-10-22; ACP saved sandbox and resume changes.
- [GitHub Copilot CLI ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server), re-read 2026-10-24; launch, stdio, BYOK and public-preview contract.
- [Copilot CLI maintained command reference](https://github.com/github/copilot-cli/blob/main/_autodocs/api-reference/cli-command.md), discovered through Context7 /github/copilot-cli; corroborates fixed copilot login and relevant launch flags. Runtime behavior above is based on the actual pinned CLI rather than the generated reference alone.
