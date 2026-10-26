# Test resource and module-loading analysis

Date: 2026-10-20 (Asia/Shanghai)

Initial analysis scope: diagnose the local Jest workload before changing implementation
or test configuration. The working tree already contained test/configuration
changes when this investigation began. Those changes were treated as baseline.
No application source, test source, or test configuration was edited here.

## Findings

The measured amplification has three interacting causes: large eager dependency
graphs, repeated evaluation of those graphs, and a worker policy that assumes
substantial memory is available regardless of current machine pressure. There
are also smaller discovery/environment costs and independently failing tests
that hold workers until a timeout. These findings do not establish a memory leak.

### 1. The local worker budget ignores competing memory demand

The machine has 48 GiB RAM and 14 logical CPUs. At inspection, free memory was
below 1 GiB; one later sample reported 0.212 GB. Compression and swap activity
were present, but their cumulative counters cannot identify the responsible run.
No Jest process was active at the initial snapshot.

`jest.config.ts:57` calculates usable memory as
`max(os.freemem(), os.totalmem() * 0.6)`. This imposes a floor of approximately
30.9 decimal GB on this machine. `fastRoomy` consequently selects 10 workers.
The effective `--showConfig` output confirmed:

```json
{ "maxWorkers": 10, "workerIdleMemoryLimit": 2000000000, "collectCoverage": false }
```

The 2 GB limit is an after-suite heap recycling threshold, not an in-flight RSS
or process-tree limit. It excludes memory used by a suite's child processes.
Serial `--runInBand` measurements do not exercise worker recycling.

Source: `jest.config.ts:57-75`, `jest.config.ts:833-839`; installed
`jest-worker@30.5.1/build/processChild.js:243` reports `heapUsed`, and
`jest-worker/build/index.js:979-987` requests this check after task completion.

Recommendation: use a conservative local default with an explicit override;
budget the entire run, including parent and child processes. Measure a worker
sweep before choosing a permanent limit. Do not infer that reducing the recycle
threshold fixes oversized individual suites.

### 2. Broad entry points eagerly import unrelated subsystems

Five temporary import-only probes used the same jsdom environment, setup,
aliases, and transform configuration. Each checked that the requested export was
a function. All five passed.

| Requested API and entry point                              | Distinct local modules evaluated | All distinct CJS modules evaluated |
| ---------------------------------------------------------- | -------------------------------: | ---------------------------------: |
| `useSettingsStore` from `@/stores`                         |                              490 |                              1,405 |
| `useSettingsStore` from `@/stores/settings/settings-store` |                              264 |                                822 |
| `createLogger` from `@/lib/logging`                        |                              272 |                                825 |
| `createLogger` from `@cognia/logging`                      |                               43 |                                484 |
| `createLogger` from `@cognia/logging/core`                 |                               27 |                                468 |

Local counts include setup and mocks, exclude node_modules and the temporary
probe file. The settings leaf remains substantial: changing a barrel import
alone does not remove the settings store's own dependencies.

Observed logging chain:

```text
lib/logging/index
  -> bootstrap / transports
  -> native-transport -> native-logging -> lib/tauri
  -> transport-instance -> transport-companion
  -> companion-storage -> credential-book -> active-account-id -> db/schema
```

Observed stores chain:

```text
stores/index -> artifact-store -> hooks-system -> plugin-store
  -> validation -> IDE manifest -> generated manifest validator
```

The logging entry point already documents the lighter `@cognia/logging`
alternative (`lib/logging/index.ts:9-11`). Reuse existing boundaries first.

### 3. Explicit resets and reload tests multiply evaluation

The measured numbers are actual calls to Jest's CJS module executor, rather
than counts of import statements or resolver requests.

| Existing suite                       | Distinct modules | Evaluations | Explanation                                      |
| ------------------------------------ | ---------------: | ----------: | ------------------------------------------------ |
| `lib/logging/index.test.ts`          |              868 |       3,915 | Nine `beforeEach` module resets                  |
| `stores/index.test.ts`               |            1,031 |       3,818 | Explicit isolation/reset plus root-store imports |
| `lib/plugin/core/manager.test.ts`    |            5,126 |      10,140 | Large graph plus a deliberate reload case        |
| `hooks/chat/use-claude-chat.test.ts` |            2,604 |       2,611 | Large graph with little same-file repetition     |

A temporary in-memory transform removed only `jest.resetModules()` from the
logging smoke suite. All nine assertions still passed. Distinct modules stayed
at 868, while evaluations fell from 3,915 to 875 (77.7% fewer). A fresh control
run reproduced the original 3,915 evaluations. Repository files were unchanged.

The manager test at `lib/plugin/core/manager.test.ts:7563` verifies reuse across
manager-module reloads using `jest.isolateModules`. Excluding this case only for
diagnosis yielded 5,126 modules and 5,126 evaluations, with 266 assertions passed
and one skipped. The full suite had passed all 267 assertions. Removing the
reload test permanently would lose required behavior coverage.

Literal inventory found 76 files using `resetModules` or `isolateModules`, with
122 call sites. This is a review candidate list, not evidence that all calls are
unnecessary. Prefer resetting state at the relevant seam where that preserves
the test's purpose; retain genuine module-load and singleton-isolation tests.

### 4. Plugin lifecycle tests cross into the UI and chat execution graph

The manager suite reached 3,382 distinct local modules. Traced examples:

```text
manager -> context -> components/plugins/dialogs/plugin-data-dialog

manager -> module-bridge-map -> context-panels-bridge
  -> plugin-declarative-context-panel -> resource-workbench-chat-panel
  -> use-claude-chat -> use-claude-chat-controller
  -> to-diagnostic -> from-execution-error -> agent-execution-service

manager -> loader -> vscode-loader -> setup-handlers -> lm-handler
  -> tokens/fallback-estimator
```

`module-bridge-map.ts:38-137` eagerly imports the bridge implementations;
`context.ts:10` statically imports the dialog. These boundaries are stronger
optimization candidates than a global mock that could hide integration errors.
Keep lifecycle unit tests focused and retain separate tests of the real wiring.

### 5. Discovery and environment costs are broad but secondary

The current inventory contains **11,762 unique test files**, with no overlap
between project matching rules: 7,264 node-project files, 4,496 jsdom-project
files, and two heavy-project files. Node-project membership does not guarantee
the Node environment: 1,695 `.ts` files in the inventory have a jsdom docblock
within their first 1,000 characters.

All three projects have the same repository-wide root and separate Haste maps.
Each map contained 36,006 files and was about 7.47 MiB serialized. This repeats
indexing/metadata work; it is not itself evidence for GB-scale duplication of
executed application modules.

Two ignored temporary audit files under
`.codex-tmp/plugin-independent-audit-2026-10-05/` were discovered as test suites.
The recent `.tmp` exclusion does not cover `.codex-tmp`.

The heavy lane currently includes only the markdown process probe and subagent
background-task process probe. Ordinary discovery still includes CLI bundle and
PTY integration suites. A literal scan found 52 files containing child-process
calls, only one of which was in the heavy lane. This scan is a candidate list:
mocked calls, skipped suites, and inexpensive commands require individual review.

For a small control, primitive Node tests evaluated 71 distinct modules each;
a mocked React hook test evaluated 461. Setup/framework and DOM costs matter
across thousands of files, but do not explain all of the large app graphs.

### 6. A functional timeout is being mixed into performance observations

An uninstrumented run of `hooks/chat/use-claude-chat.test.ts` produced:

```text
Test Suites: 1 failed, 1 total
Tests:       11 failed, 364 passed, 375 total
Time:        35.866 s
```

The test named `aborts the isolated external task when Stop is pressed without
interrupting the built-in agent` consumed 30,003 ms and failed with
`Exceeded timeout of 30000 ms for a test.` The other failures also concern Stop
handling. Instrumented and uninstrumented runs reproduced the same 11 failures.
The failure's implementation root cause was not investigated in this resource
analysis. Both hook source and tests had pre-existing working-tree changes.

Fix or reconcile this behavior before using the suite's duration as a clean
module-loading benchmark. Increasing its timeout would increase worker occupancy.

## Measurement and limits

- Installed versions: Node 26.5.0, Jest 30.5.2, Next 16.4.0.
- Temporary instrumentation wrapped the installed Jest Runtime's executor and
  recorded filename, importer, count, and execution time. Counts cover CJS
  execution, including framework code; they exclude JSON parsing, native loads,
  and any separate native ESM execution path.
- Transform-cache hits and execution are different. Each test file normally has
  its own Runtime and module registry even when `resetModules` is false. Sharing
  all module state across files would compromise isolation.
- A six-suite baseline passed 240 assertions. The four-suite graph sample had
  665 assertions passed and the same 11 hook assertions failed.
- Process-tree RSS was sampled approximately every 200 ms. The instrumented
  four-suite serial run peaked at 1,625.5 MiB; the uninstrumented hook-only run
  peaked at 917.4 MiB. These are different workloads, not an instrumentation A/B.
- No 10-worker stress run, full suite, coverage run, heap snapshot, or memory-leak
  attribution was performed. Timing samples are illustrative, not a controlled
  multi-run performance claim. RSS is not the same metric as V8 heap usage.

Raw logs, resource samples, module/import edges, probe sources, and result JSON
are in `/tmp/cognia-test-diagnosis-2026-10-20/`. These are temporary local
artifacts. The harness has a 240-second timeout for its own process tree.

Representative reproduction commands while those temporary artifacts exist:

```sh
rtk proxy python3 /tmp/cognia-test-diagnosis-2026-10-20/run.py repeat-logging --runTestsByPath lib/logging/index.test.ts
rtk proxy env COGNIA_TEST_PROBE_VARIANT=no-logging-reset python3 /tmp/cognia-test-diagnosis-2026-10-20/run.py repeat-no-reset --runTestsByPath lib/logging/index.test.ts
rtk proxy python3 /tmp/cognia-test-diagnosis-2026-10-20/run.py repeat-imports --config /tmp/cognia-test-diagnosis-2026-10-20/probe.config.json
rtk proxy env COGNIA_TEST_PROBE_DISABLE=1 python3 /tmp/cognia-test-diagnosis-2026-10-20/run.py repeat-hook --runTestsByPath hooks/chat/use-claude-chat.test.ts
```

## Recommended implementation order

1. Bound local resource concurrency and exclude temporary audit directories.
   Verify effective config and unchanged legitimate suite inventory.
2. Reconcile the Stop-action failures. Verify the original failing behavior and
   use the now-passing suite for later timing measurements.
3. Replace demonstrated broad imports with existing leaf/core entry points.
   Verify behavior plus module-count reductions under identical probes.
4. Audit resets individually, starting with logging smoke tests. Preserve
   reload/singleton coverage and verify all assertions still exercise their
   original behavior.
5. Separate process/build/PTY integration workloads with explicit execution
   policy; preserve their inclusion in appropriate default/CI validation.
6. Reduce eager plugin UI/chat coupling, then run a bounded 1/2/4-worker sweep
   measuring wall time, aggregate RSS, and process count. Consider broader test
   runtime changes only after these measured boundaries are addressed.

## Sources

- Local source and installed Jest implementation paths identified above.
- [Jest 30.5 configuration: resetModules](https://jestjs.io/docs/configuration#resetmodules-boolean).
- [Jest 30.5 configuration: workerIdleMemoryLimit](https://jestjs.io/docs/configuration#workeridlememorylimit-numberstring).

## Follow-up implementation and verification — 2026-10-20

The following work implements the first governance pass requested after the
initial analysis. It preserves the concurrent working-tree changes present at
the beginning of implementation.

### Implemented scope

- `jest.config.ts` now defaults to at most two workers locally and four in CI,
  further limited by half the CPU count and a conservative free-memory budget.
  The optimistic 60%-of-physical-memory floor is removed. The current machine
  resolves to one worker under memory pressure. Explicit Jest CLI worker
  overrides remain available. This bounds default concurrency, not in-flight
  RSS; a serial Jest run does not receive worker recycling.
- Every project excludes `.codex-tmp` from its module index. A same-tree
  discovery comparison toggling only this exclusion yielded 11,763 versus
  11,761 suites: exactly the two audit probes were removed, with no additions or
  legitimate test removals. Concurrent test renames/additions explain why these
  totals differ from the initial analysis inventory.
- Stop failures were traced to the test's incomplete mock of
  `lib/db/mobile-outbound-queue`: it omitted
  `withdrawUnsentHostStateMessages`. Calling the missing function threw into the
  controller's existing error path before interruption. The mock now supplies
  the current outbox interface. All existing Stop assertions remain. Added
  tests verify restoration of withdrawn sends while retaining confirmed messages,
  and preservation of messages/follow-ups when withdrawal fails. No production
  Stop implementation change was required.
- Plugin i18n, translation-hook, media, vector APIs, and the Monaco theme hook
  import their owning settings/vector stores directly. Updater and Update Center
  runtime use the existing `@cognia/logging` core package. Corresponding test
  mocks follow those boundaries, with their existing assertions retained.
- Removed only the logging export smoke suite's per-test `resetModules`.
  Its nine tests remain. Store isolation and manager reload tests are unchanged;
  no permanent skip, timeout increase, or assertion removal was introduced.

### Measured effects

The same nine suites and all 432 assertions were run in a fixed lexical order,
with coverage disabled, `--expose-gc`, and identical temporary instrumentation.
Two runs per source version were interleaved in the order before, after, after,
before. The old import/mock/reset sources were read from snapshots by the
temporary Runtime probe, without reverting live files. Both variants used the
new configuration, isolating import/reset effects from worker-policy effects.

| Metric                                                   |      Before |       After | Observed change |
| -------------------------------------------------------- | ----------: | ----------: | --------------: |
| Total module evaluations, nine-suite workload            |      18,107 |      14,445 |          -20.2% |
| Translation-hook suite distinct modules                  |       1,424 |         841 |          -40.9% |
| Logging suite evaluations                                |       3,915 |         875 |          -77.7% |
| Median sampled process-tree peak RSS                     | 1,304.3 MiB | 1,223.0 MiB |           -6.2% |
| Median interval from first suite start to last suite end |     6.246 s |     5.392 s |          -13.7% |
| Median end-to-end harness wall time                      |    10.695 s |    10.446 s |           -2.3% |

The individual before suite intervals were 7.154/5.338 seconds; after intervals
were 6.477/4.306 seconds. Startup and host contention vary substantially, so the
timing changes are observations from this sample, not a whole-repository speed
guarantee. The deterministic module counts are the stronger evidence. The full
manager suite still evaluates its 5,127-module graph twice for reload coverage;
this pass does not solve the broader eager plugin UI/chat coupling.

The corrected Stop suite passed **377/377** assertions (375 existing plus two
new), with a standalone uninstrumented Jest time of 5.570 seconds versus the
initial 35.866-second failing run. Its former 30-second timeout disappeared.
The subsequent broader run also passed this suite.

A bounded sweep of the same optimized nine-suite workload showed the memory
tradeoff for explicit worker overrides:

| Workers                      | End-to-end wall time | Sampled process-tree peak RSS |
| ---------------------------- | -------------------: | ----------------------------: |
| 1, median of two serial runs |             10.446 s |                   1,223.0 MiB |
| 2, one run                   |             11.778 s |                   1,567.7 MiB |
| 4, one run                   |              8.785 s |                   2,395.5 MiB |

The sweep supports a conservative local default; it does not establish a
universal throughput optimum. The old ten-worker default was not stress-tested
on the already pressured machine. RSS sampling can miss sub-200-ms peaks.

### Validation results

```text
Broader Jest regression:
Test Suites: 101 passed, 101 total
Tests:       2353 passed, 2353 total
Snapshots:   0 total
Time:        35.571 s

Configuration + CLI forwarding tests:
tests 10
pass 10
fail 0
skipped 0
```

The broader set includes every suite under `lib/plugin/api`, the full chat
action suite, updater/runtime, logging, Monaco theme hook, stores barrel,
complete manager lifecycle/reload suite, real outbox tests, and composer
restoration tests. No coverage instrumentation or threshold check was requested
or run. Preserving coverage here means retaining behavior tests and assertions,
not claiming a measured coverage percentage.

Additional checks passed:

- The real `pnpm typecheck` command, including its root compiler and both sidecar
  TypeScript projects, exited 0. Its webclone build prerequisite reported its
  output up to date. An unfiltered execution log confirms the actual commands.
- ESLint over all 18 task-owned code/config/test files: exit 0, no warnings.
- Prettier over those 18 files: all matched files use Prettier code style.
- Task-owned diff whitespace check: exit 0.
- Scoped test-gap/coverage-preservation and i18n reviews: no actionable findings.

This pass did not run the entire approximately 11.8k-suite repository, a full
application build, desktop UI E2E, or coverage measurement. Production edits
only change import targets, and no UI behavior or translation strings changed.

Implementation snapshots, owned file manifest, regression results, gate logs,
and measurement summary:
`/tmp/cognia-test-governance-2026-10-20/`.
Runtime module traces, fixed-order sequencer, and per-run resource samples:
`/tmp/cognia-test-diagnosis-2026-10-20/`.
The same-tree discovery artifacts are
`/tmp/cognia-jest-governance-{before-list,list,showconfig}.json`.

Remaining opportunities from the wider analysis are architectural rather than
unfinished changes in this pass: eager plugin UI/chat dependencies, additional
barrel consumers, and classification of build/PTY integration workloads. They
retain their existing execution and coverage behavior.
