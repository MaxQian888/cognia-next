# Test runner budgets and execution boundaries research

Date: 2026-10-20. This continues the [test resource follow-up](2026-10-20-test-resource-follow-up.md). The research sections record the initial investigation without retained source changes; the implementation follow-up records subsequently authorized fixes. The companion [measurement data](2026-10-20-test-runner-and-execution-boundaries-research-data.json) includes individual runs, commands, outcomes, dispersion, and source fingerprints.

## Findings and priority

1. Give the separate Node script-test runner an explicit concurrency budget. Jest's limits do not reach it. A bounded three-file experiment shows a resource tradeoff worth testing across complete script groups.
2. Repair two independently reproduced fixture failures before using those suites as acceptance gates: the browser built-in count is stale, and the safe-send suite's workspace-client mock omits a superclass.
3. Define workflow registration and first-execution contracts before further deferring PluginManager dependencies. A candidate removes 13.7% of module evaluations while changing initial registry population; the existing manager suite does not detect that difference.
4. Preserve VS Code module resets until their state/mocking boundary is redesigned. Simply removing them breaks error propagation. Deferring presenter components reduces evaluations but produces no meaningful measured wall-time or memory gain.

No implementation is recommended solely on the basis of a smaller import graph. The research checkpoint retained only research artifacts; see the implementation follow-up for subsequent changes.

## Measurement contract

- Host: macOS arm64, Node 26.5.0, Jest 30.5.2, 14 logical CPUs, 48 GiB RAM; shared dirty checkout.
- Existing Jest tests run through `pnpm test`, serially. Temporary source overlays modify only each child process's in-memory source reads. Existing assertions remain intact. Additional diagnostic assertions exist only in those overlays.
- CJS executor instrumentation counts distinct evaluated files, repeated evaluations, and explicit reset calls. Recorded edges identify the first evaluation parent, not every import or cache hit. These are structural metrics, not production bundle sizes.
- Resource measurements sample the complete command's descendant process tree with `ps` approximately every 200 ms. RSS is the sum of sampled process RSS, not unique physical memory; short-lived peaks may be missed. Process counts include runners and compiler descendants.
- Presenter timing uses one warmup per variant, fresh child processes with warm transform caches, then 10 alternating control/candidate pairs, reversing the order on alternate pairs. Executor profiling is disabled for timed comparisons. The predeclared acceptance threshold is at least 10% improvement and an absolute difference greater than twice the larger median absolute deviation (MAD).
- Node concurrency measurements use three samples per policy, alternating sequentially with no other task-owned test process active. Earlier overlapping screens are retained in the ignored raw directory but excluded from the comparison. System-wide activity is not controlled.
- Fifteen monitored source/configuration SHA-256 fingerprints remained unchanged after the experiments. No cache deletion, coverage run, provider request, native build, or remote CI run was performed.

Raw local evidence and source-overlay tooling: `.cache/test-resource-research-2026-10-20/continuation-02/` (`contract.md`, `probe.cjs`, `overlays.cjs`, `run.py`, logs and JSON). That directory is ignored; the companion JSON preserves the compact measurements and commands. The temporary overlays are diagnostics, not a proposed patch.

## Node script tests have a separate concurrency budget

The root `package.json` invokes `node --test` directly for `scripts:test:build`, `scripts:test:ci`, and `scripts:test:gates`, without `--test-concurrency`. The build command selects 66 files in this checkout; the gates command selects 53. The CI command also prepares a Rust binary and selects several script directories and explicitly named files.

The installed Node implementation uses `availableParallelism() - 1`, with a minimum of one, as the default process-isolated root concurrency. This host reports 14, so the default permits 13 test-file children. This conclusion comes from the installed runtime's `internal/test_runner/utils` and `internal/test_runner/test` source, accessed through `process.binding('natives')`. The installed runtime does not allow `--test-concurrency` in `NODE_OPTIONS`; any governance wrapper must pass it in the actual Node arguments.

`scripts/gates/check-all.mjs` caps concurrent gate groups at four by default and keeps tasks within a group serial. These three script-test commands belong to the same `gate-tests` group, so this is **not** evidence that all three run at 13 workers simultaneously. A script-test group can still overlap work in other gate groups. CI matrix jobs also have their own process budgets. Jest worker governance alone therefore does not bound this part of local or CI resource consumption.

The resource screen uses these existing fixture-based tests, including real esbuild work inside temporary directories:

- `scripts/build/build-browser-builtin-plugins.test.mjs`
- `scripts/build/build-workflow-app-embed.test.mjs`
- `scripts/build/bundle-tui-fixture.test.mjs`

| Node policy            | Wall median, s (range) | Peak tree RSS median, MiB | Maximum descendant process count, median |
| ---------------------- | ---------------------- | ------------------------- | ---------------------------------------- |
| Default                | 0.916 (0.913–1.156)    | 373.1                     | 9                                        |
| `--test-concurrency=2` | 0.926 (0.916–2.469)    | 288.5                     | 6                                        |
| `--test-concurrency=1` | 2.312 (1.595–2.546)    | 201.1                     | 4                                        |

Each row has three samples. The concurrency-two RSS median is 22.7% lower than default; serial is 46.1% lower. The variable timings and small sample make this an exploratory resource tradeoff, not proof of a full-lane throughput improvement or a universal choice of two workers. All nine runs exit 1 with the same **12 passed / 1 failed** outcome; the stale assertion below remains enabled. These are not measurements of a green full build lane.

The next implementation should budget Node and Jest independently, provide a deliberate override, retain every default/CI test selection, and measure complete build/gates/CI script groups under bounded policies before choosing the default. Within-file concurrency and compiler children also require attribution rather than treating a worker count as the complete process budget.

## Two fixture failures need repair

### Browser built-in count drift

`scripts/build/build-browser-builtin-plugins.test.mjs:11` requires `BROWSER_BUILTIN_PLUGIN_IDS.length === 54`. The builder reads the curated `plugins/browser-builtins.json`, which currently contains 57 entries. The observed failure is `57 !== 54`, identically reproduced at all tested concurrency settings.

Reconcile the intended curated inventory and its tests; preserve meaningful membership and uniqueness checks. This investigation does not establish that any of the 57 plugins should be removed, nor that the count assertion should simply be deleted. No fixture assertion was changed.

### Safe-send mock no longer supplies a required class

`lib/connectors/ai-loop/safe-send-prompt.test.ts` replaces the entire `@/lib/task-workspace/client` module with a mock containing workspace acquisition functions. It omits `WorkspacePortLeaseError`, which is exported by the real client. `lib/task-workspace/managed-workspace.ts:357` now declares `ManagedWorkspacePortLeaseCleanupError extends WorkspacePortLeaseError`.

The suite fails during module evaluation with:

```text
TypeError: Class extends value undefined is not a constructor or null
```

The six-suite execution-boundary check passes five suites and 144 tests, while this suite cannot start. A separate unmodified baseline reproduces the same load failure with zero tests executed. This is mock drift, not evidence of a production superclass failure or a PII bypass. Restore a faithful mock boundary and rerun the PII assertions before calling that acceptance gate green.

## PluginManager still reaches workflow and agent execution

Source tracing and first-evaluation edges identify independent routes:

- Manager → context/API construction → workspace bot binding → `bot-integration-binding.ts` → `readJsonPointer` from `lib/integrations/events.ts` → trigger bridge → execution authority → workflow orchestrator and built-in registration.
- `workflow-author-api.ts` imports both the workflow orchestrator and the typed workflow runner; execution authority also reaches the orchestrator through `run-from-step.ts`.
- Connector bus → control-command dispatch → goal command → headless goal runner → Claude build options.
- Slash-command built-in catalog → diagnostics action → `resolveSendOptions` → Claude build options. Deferring only connector dispatch leaves this independent route active.

The overlay screens defer existing asynchronous execution entry points and forward their arguments to the real implementations. The workflow screen also copies the exact JSON-pointer helper into the overlay to isolate the pure-helper dependency; this duplication is diagnostic only and is not a production extraction proposal.

| Complete manager suite variant       | Distinct files | CJS evaluations | Existing tests |
| ------------------------------------ | -------------: | --------------: | -------------: |
| Control                              |          3,663 |           7,203 |     267 passed |
| Workflow entry seams                 |          3,374 |           6,622 |     267 passed |
| Connector dispatch seam              |          3,623 |           7,123 |     267 passed |
| Both                                 |          3,334 |           6,542 |     267 passed |
| Both plus diagnostics execution seam |          3,173 |           6,219 |     267 passed |

The final screen removes 490 distinct files and 984 evaluations (13.7%). These are single profiled structural screens, not repeated speed benchmarks. Original isolated-registry tests remain; no explicit manager resets were removed. The workflow orchestrator and built-in index are absent from the workflow-deferral screens. Claude build options disappear only after the diagnostics route is deferred too.

### Passing existing tests does not establish registration parity

The orchestrator imports `lib/workflow/nodes/built-ins/index.ts` for synchronous registration side effects. The registry uses `__builtin__` ownership and a first-wins cross-plugin conflict policy. An extra in-memory assertion checks that `getExecutor("trigger.manual", 1)` exists after the existing manager tests:

- Control: **268 passed**.
- Final deferral screen: **267 passed / 1 failed**, because the executor is undefined.

This demonstrates a changed initial population contract. It does not prove that a real workflow fails after its first execution import. Nor does it establish a normal-plugin takeover: `createWorkflowAPI` prefixes plugin kinds through `prefixPluginKind` before registration. That namespacing must be distinguished from direct registry access and import-order behavior.

Desktop startup also imports the orchestrator through `workflow-runtime-provider` → resume controller; headless initializers load workflow runtime separately. A safe next change needs an explicit initialization owner and checks for both startup paths, first execution, conflict ownership, and permission/PII behavior. A lightweight registration boundary with deferred implementations is a research direction; generated registry metadata from this profile must not become production truth. No such implementation or real desktop/headless execution was validated here.

## Reset pressure is real, but removing resets breaks isolation

The initial screen keeps all existing resets and passes **4 suites / 101 tests**:

| Suite                 | Distinct files | Evaluations | Explicit resets |
| --------------------- | -------------: | ----------: | --------------: |
| Plugin loader         |          1,338 |       2,804 |               4 |
| VS Code loader        |          1,428 |       9,905 |              21 |
| Workflow Tauri bridge |            747 |       1,278 |              19 |
| Plugin asset resolver |             71 |          73 |               3 |

The VS Code loader has dispatcher setup state, cached native invocation, document synchronization, and generation maps. Repeated bootstrap evaluation loads presenter UI and a **10,536,499-byte** generated IDE manifest validator nine times. The validator is a further attribution target; size and repetition alone do not establish a safe replacement. Its generator already sets `inlineRefs: false`, and existing schema tests require CSP-safe validation without runtime code generation.

A negative control removes only `jest.resetModules()` calls in memory while retaining every assertion. The full file reaches the 180-second experiment deadline and is terminated; it produces no completed suite result. A focused comparison of load and activate error propagation gives:

- Normal resets: **3 passed**, 18 excluded by the diagnostic name filter.
- Removed resets: **1 passed / 2 failed**, 18 excluded by the same filter.

Cached invocation mocks cause expected rejections to resolve instead. This is direct evidence that these resets currently enforce meaningful state/mocking boundaries. The diagnostic filters do not alter default or CI selection. Global reset removal or shared module-cache reuse is not justified.

## Presenter deferral reduces evaluations without a useful measured gain

A separate overlay replaces VS Code presenter component imports with React `lazy`/`Suspense` wrappers that load the real components when mounted. It keeps all 21 loader resets. The loader profile drops from 9,905 to 8,789 evaluations (11.3%) and from 1,428 to 1,304 distinct files.

The existing loader and presenter suites pass **28 tests**. An additional in-memory DOM check mounts the real deferred message toast with the existing internationalization provider, waits for its content, clicks its action, and verifies the returned choice: **8 presenter tests pass**, including this extra check. This validates one first-use interaction in jsdom, not complete modal, quick-input, status-bar, browser, or native parity.

The repeated full-loader comparison retains all 21 tests in every sample:

| Metric                     | Control median (MAD)    | Deferred presenter median (MAD) | Median change |
| -------------------------- | ----------------------- | ------------------------------- | ------------- |
| Complete command wall time | 11.075 s (0.580 s)      | 11.106 s (0.914 s)              | +0.3%         |
| Peak descendant-tree RSS   | 1,463.65 MiB (9.40 MiB) | 1,457.85 MiB (18.60 MiB)        | −0.4%         |

All 20 timed samples pass all 21 loader tests. Neither difference meets the predeclared practical or dispersion threshold. **Verdict: no meaningful end-to-end improvement demonstrated.** No presenter patch is retained or prioritized solely for Jest performance. Framework/configuration/process costs remain part of the measured total, but this experiment does not diagnose which one dominates.

The current Jest configuration already handles native TypeScript/CJS path differences and ignores relevant generated/cache directories. Those existing protections should not be proposed again as new fixes. Similarly, runtime Ajv compilation would not be a justified shortcut around the validator's CSP contract.

## Validation boundary and next work

The next implementation order should be: repair the two fixture failures; introduce explicit Node runner budgets with unchanged test membership; measure the complete bounded lanes; then design the workflow initialization boundary and VS Code test-state seams before changing imports or resets.

At the research checkpoint, no full default lane, CI run, repository lint/typecheck/build, requested coverage target, real provider call, or native UI/workflow acceptance was claimed. Repository gates had not been rerun for that research-only phase. The original failures, negative controls, noisy samples, and unsuccessful optimization candidate remain in the recorded results. No source/configuration optimization was retained at that checkpoint; subsequent implementation results follow below.

## Implementation follow-up

Following authorization to fix the findings, this phase repairs the two reproduced fixture failures and introduces an explicit budget for the three large Node script-test groups. Production application code, workflow registration, presenter loading, and module resets remain unchanged.

### Changes and safety checks

- `build-browser-builtin-plugins.test.mjs` retains an exact inventory assertion, updated to 57 after verifying that the three additions are the committed VNC, RustDesk, and web-console provider plugins. It retains existing membership assertions and adds membership for those three plugins and a uniqueness assertion. The curated production inventory is unchanged.
- `safe-send-prompt.test.ts` supplies the real `WorkspacePortLeaseError` export in its workspace-client mock, following the existing managed-workspace test pattern. Host functions and model calls remain mocked. The previously unloadable suite now runs all 28 tests.
- New `scripts/test/node.mjs` provides the Node CLI boundary that the Jest-specific wrapper cannot own. It launches the real Node test runner with at most two file workers by default (one when available parallelism is at most two). `NODE_TEST_CONCURRENCY` overrides the default; an explicit `--test-concurrency` overrides the environment. Invalid environment values fail explicitly. Selectors, reporters, Node validation of CLI values, inherited Node arguments, failure exits, and signals are preserved.
- `package.json` routes only `scripts:test:build`, `scripts:test:ci`, and `scripts:test:gates` through this wrapper. Comparing their strings with the captured pre-change scripts confirms identical file patterns and unchanged CI Cargo preparation. The new runner's tests are automatically selected by the existing `scripts/test/*.test.mjs` CI glob. Other independent script-test commands are outside this change's budget.
- Five prior Jest lane/config helpers now have ownership entries in `check-gate-registry.mjs`: unit/heavy/build/pty are subsets of the full Jest CI plan; config checks are already selected by `scripts:test:ci`. These entries avoid duplicated full-suite runs and do not exempt any previously uncovered tests. The shared tree's pre-existing sidecar exemption is preserved.

The new runner's regression tests cover actual multi-file execution and fan-out, environment and CLI precedence, failure propagation, and POSIX shutdown without an orphaned test worker. The initial shutdown regression failed because Node can convert SIGTERM to exit 1; the wrapper now remembers and preserves its received signal. The original assertion passes after that correction. Windows signal behavior was not exercised; that POSIX-specific check is skipped there.

Examples:

```bash
pnpm run scripts:test:build
NODE_TEST_CONCURRENCY=1 pnpm run scripts:test:build
pnpm run scripts:test:build --test-concurrency=4
```

With fixed file arguments in package scripts, pass the CLI flag as shown, without adding a later bare `--`. The wrapper preserves a caller's literal argument separator.

### Complete build-group measurements

The predeclared comparison uses all 66 existing build test files, after applying identical fixture repairs to both policies. There is one warmup per policy, then three alternating samples per policy, with fresh processes, existing warm caches, no executor profiler, and no other task-owned test process active. The first unrestricted warmup overlapped an automatic pnpm workspace preparation and is excluded from the measured comparison. No caches were deleted. Build tests regenerate their existing sidecar artifacts and use temporary fixtures.

| Complete build-group metric      | Unrestricted Node median (MAD) | Bounded wrapper median (MAD) | Change |
| -------------------------------- | ------------------------------ | ---------------------------- | ------ |
| Wall time                        | 70.555 s (0.381 s)             | 75.627 s (0.306 s)           | +7.2%  |
| Peak descendant-tree RSS         | 3,141.9 MiB (111.0 MiB)        | 2,696.5 MiB (48.1 MiB)       | −14.2% |
| Maximum descendant process count | 24 (0)                         | 8 (0)                        | −66.7% |

All six measured runs execute **438 tests: 434 passed / 4 failed / 0 skipped**, with exactly the same failure names. This preserves the workload, rather than obtaining a gain by omitting tests. All 163 monitored benchmark input hashes remain unchanged throughout the comparison. The later signal correction changes cancellation handling only; the final complete entry-point acceptance run is recorded separately from these timing samples.

The predeclared RSS acceptance rule requires at least 15% improvement and a delta greater than twice the larger MAD. The observed RSS delta clears the dispersion rule but misses the practical threshold. **Verdict: retain the explicit worker budget as deterministic resource governance; do not claim a significant general memory or throughput improvement.** The observed process reduction is accompanied by a runtime cost. A single memory-heavy contract file can still dominate the job's peak. Three full-group samples per policy remain a small local experiment, not a CI performance guarantee.

### Verification and remaining workspace failures

| Check                                                                    | Actual result                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Runner and browser built-in tests                                        | 14 passed; zero failed/skipped on this macOS host                        |
| Focused safe-send, managed-workspace, manager, VS Code loader regression | 4 suites / 351 tests passed                                              |
| Complete build selection, both policies                                  | 434 passed / 4 identical failures, no skipped tests                      |
| Complete bounded gates entry point                                       | 862 passed / 4 failed, no skipped tests                                  |
| Complete bounded CI script entry point, including Cargo preparation      | 520 passed / 2 failed, no skipped tests                                  |
| CI failure suites using direct Node, without wrapper                     | 14 passed / same 2 failed                                                |
| Complete gates selection using direct Node, without wrapper              | Same 866 tests and 4 failure names                                       |
| Scoped ESLint, zero warnings allowed                                     | Passed for the runner, its tests, fixture fixes, and gate ownership file |
| `pnpm lint:i18n`, `pnpm i18n:sort:check`                                 | Passed                                                                   |
| `pnpm typecheck`                                                         | Failed with two errors in untouched harness tests                        |
| `pnpm lint`                                                              | Failed: 81 errors / 4,856 warnings in the wider workspace                |

Remaining build failures concern the sidecar source-alias inventory, an assertion requiring the former `tsc --noEmit` command spelling, the scheduler contract missing `harness-evolution-sweep`, and browser ticket audience schema drift. They reproduce before and after the budget change.

The gates failures concern the co-located-test baseline, a Docker build-command expectation, gate ownership for the unrelated `host:archive:test` and `update:catalog:test` commands, and stale identity-vocabulary exceptions. The CI script failures concern Feishu's workflow inventory and the coverage source manifest's synchronization with Jest. The latter is a manifest self-test; no coverage collection was run or threshold lowered.

Typecheck reports `TS2698` in `components/harness/harness-failure-offer.test.tsx:86` and `TS2459` in `components/harness/harness-snapshot-diff.test.tsx:4`. These files were not changed in this phase. The full workspace is therefore not represented as green. Focused tests and audits verify the scoped changes; they do not establish remote CI, real provider, native desktop, or browser acceptance. No application build or coverage run was requested or performed.

Implementation raw logs, commands, fingerprints, and the preregistered contract are under `.cache/test-resource-fixes-2026-10-20/`. The companion JSON's `implementationFollowUp` contains the retained compact evidence, including initial failed shutdown checks and successful corrected checks. There are no timing thresholds added to CI.
