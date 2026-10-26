# PluginManager loading and heavy test lanes

Date: 2026-10-20 (Asia/Shanghai)

This continues the [test resource investigation](2026-10-20-test-resource-and-module-loading-analysis.md).
The shared working tree already contained unrelated application, test, build,
and CI changes. Measurements compare against a snapshot taken immediately
before this phase, rather than against `HEAD`.

## Changes

PluginManager no longer eagerly loads these UI surfaces through context/API
construction:

- `context.ts` returns the same synchronous modal API and queues a stable
  `next/dynamic` dialog component. A store subscription settles dismissal if
  the modal closes before the lazy component mounts.
- `artifact-api.ts` retains synchronous, stable built-in/default/preview
  component getters. Each component loads its existing implementation when
  rendered. Artifact CRUD does not trigger the renderer import.
- `context-panels-bridge.ts` imports declarative/chat or webview/RPC factories
  only in the corresponding, permission-checked registration branch. The
  existing asynchronous registration still waits for loading; unregister
  uses the existing registry and saved disposers without loading renderers.
- `vscode-loader.ts` imports and installs VS Code RPC handlers inside the
  existing awaited dispatcher initialization, before starting the host.

No manager reload/reset test was removed. Error reporting, permission checks,
registration teardown, and the existing production UI implementations remain
in their original call paths. Tests exercise cold API/registration imports,
an actual deferred dialog action, dismissal before mounting, and mounting all
seven lazy artifact getters with observable forwarded props. The separate
co-located artifact render suite keeps DOM setup out of the existing Node CRUD
suite.

## Test lanes and validation retention

| Command                     | Projects          | Intended work                                       |
| --------------------------- | ----------------- | --------------------------------------------------- |
| `pnpm test -- <args>`       | All five          | Existing default validation                         |
| `pnpm test:unit -- <args>`  | node, jsdom       | Unit and DOM tests without classified heavy work    |
| `pnpm test:heavy -- <args>` | heavy, build, pty | All classified heavy work                           |
| `pnpm test:build -- <args>` | build             | Two CLI bundle suites and the Markdown build probes |
| `pnpm test:pty -- <args>`   | pty               | Nine conversation suites and the native PTY harness |

Explicit heavy lanes default to one worker. An explicit `--runInBand`, `-i`,
`--maxWorkers`, or `-w` remains authoritative. The existing conservative global
worker budget still applies to default validation. Worker recycling does not
cap the in-flight RSS of a serial suite or its child processes.

The wrapper removes pnpm's leading forwarded `--` after the lane argument and
delimits Jest's variadic project selector before test paths. It preserves a
later caller-written separator and the unchanged default forwarding path.

Files were classified by their existing paths; none were renamed. The pure
`terminal-screen.test.ts` helper stays in the Node unit project. Before the
additional artifact render suite, default discovery contained exactly the
same 11,761 paths before and after this phase, with no additions/removals or
overlap: 11,747 unit, 3 build, 10 PTY, and 1 remaining process/disk suite.
The final discovery snapshot found all original paths plus the new artifact render suite
and 18 tests added concurrently by other work: 11,780 paths, zero original
paths removed. Those 18 additions are outside this change.

The existing CI discovery/planning still sees every project. Full-plan
`--runTestsByPath` execution adds no project filter. CLI bundle/native-helper
prerequisites continue to reference the original paths. Contract tests check
that build, PTY, and ordinary terminal-helper paths survive planning and exact
execution. Remote CI itself was not run in this session.

## Controlled PluginManager comparison

The unchanged `lib/plugin/core/manager.test.ts` ran all 267 tests in each run,
including its intentional module reload case. Runs alternated before, after,
after, before with one process, the same five-project configuration, fixed
test order, no coverage, and the same runtime instrumentation. Before sources
were overlaid in the Jest file reader from the phase snapshot; repository
files were not reverted. Both variants used the same current dependencies and
unrelated shared-tree code.

The probe counted actual Jest CommonJS executor calls, rather than import
statements. Process-tree RSS was sampled every 200 ms, including descendants.
Module counts include setup, mocks, dependencies, and deliberate reevaluation.

| Metric                           |      Before |       After |                  Change |
| -------------------------------- | ----------: | ----------: | ----------------------: |
| Distinct evaluated modules       |       5,131 |       3,650 |                  -28.9% |
| Module evaluations               |      10,150 |       7,177 |                  -29.3% |
| Median peak process-tree RSS     | 1,219.4 MiB | 1,124.2 MiB |                   -7.8% |
| Median suite time                |     3.556 s |     2.974 s |                  -16.4% |
| Median startup-to-exit wall time |     9.900 s |     9.864 s | Approximately unchanged |
| Passing tests per run            |         267 |         267 |               Preserved |

| Run      | Wall time | Peak process-tree RSS | Suite time |
| -------- | --------: | --------------------: | ---------: |
| Before 1 |  10.372 s |           1,168.6 MiB |    3.856 s |
| After 1  |   9.556 s |           1,138.4 MiB |    2.925 s |
| After 2  |  10.171 s |           1,109.9 MiB |    3.023 s |
| Before 2 |   9.427 s |           1,270.2 MiB |    3.256 s |

The after graph no longer evaluates the data dialog, artifact preview,
workbench chat panel, or chat controller during the manager suite's cold load.
Substantial non-UI dependencies remain; this does not claim that PluginManager
has become a small or isolated module. Two runs per variant on a shared host
support a local observation, not a universal timing guarantee. Startup and
discovery dominate this small invocation, so the suite improvement must not be
presented as an end-to-end speedup.

Raw profiling data and the temporary harness are under
`/tmp/cognia-test-diagnosis-2026-10-20/` (`graph-before-*`, `graph-after-*`).
Phase snapshots, inventories, logs, and the compact measurement table are
under `/tmp/cognia-plugin-graph-2026-10-20/`.

## Representative lane measurements

This selection contains `entry.bundle.test.ts`, `conversation-driver.test.ts`,
and `terminal-screen.test.ts`. Each run uses fixed lexical ordering, one
process, no coverage, no runtime executor instrumentation, and the same
process-tree RSS sampler. The baseline config is the saved three-project
configuration with only its import/root paths adjusted to work from `/tmp`.
Both lane variants use the optimized production sources, isolating the test
classification effect from the PluginManager source comparison above.
The two bundle runs execute their original build prerequisites. This is one
representative invocation per variant on a shared host, not a full-suite
benchmark or a repeated estimate of build performance.

| Invocation                                          | Passing suites / tests | Wall time | Peak process-tree RSS |
| --------------------------------------------------- | ---------------------: | --------: | --------------------: |
| Before: unit projects, same three requested paths   |                 3 / 27 |  30.714 s |           2,695.8 MiB |
| After: unit projects, same three requested paths    |                 1 / 14 |   5.202 s |             441.3 MiB |
| After: default projects, same three requested paths |                 3 / 27 |  34.153 s |           2,881.4 MiB |

The unit invocation avoids 83.1% of wall time and 83.6% of peak RSS in this
selection by deferring the build/PTY assertions. The complete selection still
runs all 27 assertions. Its measured cost did not improve: it was 3.439 s and
185.6 MiB higher in this sample. Jest-reported suite time was nearly unchanged
(26.981 s before, 27.152 s after); startup, discovery, and shared-host variation
also contribute to total wall time. Classification does not eliminate heavy
work or establish a full-suite speedup.

The earlier PTY control ran `conversation-driver.test.ts` and
`terminal-screen.test.ts` together: 15 passing tests, 10.202 s wall time,
2,157.5 MiB peak RSS. It includes fixture generation and is retained as context,
not compared against a later cached helper-only run as an implementation
speedup. Raw lane measurements use the `layer-*` labels in the profiling folder.

## Verification and remaining baseline failure

The complete heavy lane executed 14 suites / 85 tests in 288.510 s:
13 suites and 83 tests passed; two tests in `coding-loop.bundle.test.ts` failed.
All ten PTY suites passed, as did CLI entry, Markdown build, and process/disk
persistence checks. No native prerequisites, assertions, or cases were skipped
to obtain this result.

The OpenAI coding-loop fixture assumes the entire coding tool catalog is
advertised immediately. The current agent defers some tools behind
`ToolSearch` to honor its tool-definition cap. The scripted fixture calls those
tools without first discovering them, so its initial tool assertion fails and
the following resumed-history assertion cannot find a successful fixture
result. Rerunning all three OpenAI cases against the saved original Jest
configuration reproduced the same two failures (one pass, three Anthropic
cases filtered out). The original failure was:

```text
Missing advertised coding tools: sandbox_write, codegraph_search,
ast_grep_search, lsp_hover, terminal_repl_spawn
```

This failure remains visible in default/CI validation. Fixing the scripted
provider to perform tool discovery is follow-up work; this optimization does
not disable the production cap or weaken the coding-loop assertions. Evidence:
`heavy-results.json`, `coding-baseline-full.json`, and their logs in the phase
folder.

The broad plugin/API/UI regression initially passed 104 suites and failed
three expectations in the remaining webview suite. Those expectations omitted
the existing host's third `postMessage` argument. They now explicitly require
the empty transfer list as well as the original visibility payload and origin;
the production webview implementation was not changed.

Final validation:

| Check                                                                                        | Actual result                                                    |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Default `pnpm test` with the 105 selected plugin/API/UI suites                               | 105 suites, 2,406 tests passed; exit 0                           |
| `pnpm test:unit -- --runTestsByPath hooks/chat/use-claude-chat.test.ts --runInBand --silent` | 377 tests passed, including the Stop regression; exit 0          |
| Node runner: Jest config/wrapper, CI planner, CLI bundle, workflow contracts                 | 112 tests passed; exit 0                                         |
| Actual package `test:build` / `test:pty` commands with forwarded `--listTests --json`        | Correctly selected 3 build / 10 PTY suites; exit 0               |
| Scoped configured ESLint on owned code/config/test files                                     | Exit 0                                                           |
| Prettier on owned code/config/test/report files                                              | Passed                                                           |
| `pnpm lint:i18n` and `pnpm i18n:sort:check`                                                  | Exit 0; parity and referenced-key checks passed                  |
| Actual unfiltered `pnpm typecheck`                                                           | Exit 2: unrelated shared-tree integration errors described below |

The 105-suite run printed Jest's one-second open-handle warning, then exited
normally with status 0. This is recorded rather than interpreted as proof of
a leak or suppressed with `--forceExit`. A subsequent `--detectOpenHandles`
run of context, context-panel bridge, and lazy artifact rendering passed all
356 tests and exited 0 without reporting open handles. That focused check does
not identify the origin of the broader invocation's transient warning.

The first full typecheck reported:

```text
lib/share/backup-share-gate.ts(53,14): error TS2739:
... is missing the following properties from type
'Record<keyof BackupPayloadV3, BackupShareDomain>':
promptOverrideRevisions, promptOverrides
```

Those two fields were added by concurrent prompt-override work to
`lib/data/types.ts`. Neither that type nor the share-domain map is owned by
this optimization. The shared integration needs both mappings completed and
the full command rerun. Its sidecar typecheck step was not reached after the
root error. A green repository-wide typecheck is therefore not claimed.

Shared-tree changes continued during final review, so the actual command was
rerun. It again exited 2, now with ten diagnostics across
`lib/agent/prompts/plan-mode.test.ts`, `lib/claude/build-options.ts`,
`lib/harness/snapshot.test.ts`, `lib/harness/tree.test.ts`, and the same share
map. These include renamed/missing prompt exports/constants and harness fixture
type mismatches. None of those files is in this phase's owned scope. The final
diagnostics are preserved in `typecheck-current.log`; the original run is in
`typecheck-final.log`. The prompt/harness integration and share map need to be
completed before rerunning the repository-wide gate.

Read-only test-gap, wiring, static-export, and i18n audits found no new blocker
in this change. This phase did not execute a complete Next static-export
build, desktop/browser E2E, remote CI, or coverage collection. The build tests
above validate their own CLI/Markdown artifacts, not the entire application.
No commit was created and unrelated working-tree changes were preserved.
