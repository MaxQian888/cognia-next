# Test resource follow-up: runtime boundaries and build reuse

Date: 2026-10-20 (Asia/Shanghai)

This is a research continuation of the [PluginManager and heavy-lane work](2026-10-20-plugin-manager-loading-and-heavy-test-lanes.md).
The research sections below made no handwritten production, test, or runner configuration changes.
The subsequently authorized fixes and their fresh validation are recorded in the final section.
The old `/tmp` traces are no longer present; historical measurements in the
previous report are not reused as a fresh baseline.

Machine-readable measurements are preserved in
[the data file](2026-10-20-test-resource-follow-up-data.json). The ignored raw
traces, temporary source overlays, commands, and experiment contract are in
`.cache/test-resource-research-2026-10-20/continuation-01/`.

## Findings and priority

| Priority            | Evidence                                                                                                                                 | Next implementation seam                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| High                | The PTY freshness check notices unrelated test edits but misses a package source bundled into the fixture                                | Track actual build inputs and configuration; test both invalidation and reuse                                 |
| High                | Local CLI bundle suites independently run an unconditional preparation pipeline; one invocation cost 8.780 s and 2,135 MiB peak tree RSS | Extend the existing prepared-artifact mechanism for one local test invocation, with dirty-source fingerprints |
| High                | Hashed output generations accumulate in a shared chunk directory                                                                         | Isolate output ownership and publish complete artifact manifests before pruning old generations               |
| Medium              | Tiktoken construction happens during module evaluation, even if estimates are never requested                                            | Defer construction until the first exact fallback estimate; preserve the synchronous API                      |
| Medium              | Plugin API construction still reaches workflow and headless execution code                                                               | Defer actual execution at existing async boundaries while preserving registry bootstrap and permissions       |
| Low for performance | Two narrower project-API import screens saved only 0.14% and 0.28% of evaluations                                                        | Do not treat these small leaf changes as a large-graph optimization                                           |

These are implementation priorities, not claims that an unimplemented change
has improved end-to-end performance.

## Measurement contract and limitations

The host is macOS on arm64, with 14 logical CPUs and 48 GiB RAM, running Node
v26.5.0 and Jest 30.5.2. The baseline is the current shared dirty working tree;
the data file records `HEAD` and hashes for nine relevant source/config files.
Those monitored files had no hash drift during the experiments. CodeGraph had
no index, so navigation used current source and literal searches.

Every manager run used the actual `pnpm test` wrapper, an in-band Jest runner, the entire
unchanged `lib/plugin/core/manager.test.ts`, and no coverage. All 267 tests,
including the reload case, passed in each run. A plain warmup preceded the
profiled comparison. Existing caches were retained; no cache cleanup occurred.
RSS samples include descendant processes and were taken every 200 ms.

The temporary probe counts actual Jest CommonJS executor calls and first-load
edges. It does not measure an application's browser bundle or every native
ESM import. The source variants were supplied through Jest's in-memory file
reader, not written over repository files. They are diagnostic counterfactuals,
not shipped patches.

The constant-map screen used control, variant, variant, control order. The
predeclared structural screening threshold was a 10% reduction in evaluations,
with all tests preserved. Resource samples this small remain exploratory. No
new time/RSS optimization is established by these runs: shared-host variation
is large, and the sample count is below the repeated-comparison contract.
Some early manager screens overlapped the directory/closure attribution scans;
they were not an idle-host timing trial. Their graph counts are the useful
screening result. Cross-phase wall/RSS figures must not be compared directly:
this pass measures the full pnpm/wrapper process tree in its current cache and
working-tree state, and the earlier raw traces are unavailable.

| Run                              | Distinct modules | Evaluations | Wall time | Peak tree RSS | Passing tests |
| -------------------------------- | ---------------: | ----------: | --------: | ------------: | ------------: |
| Control 1                        |            3,663 |       7,203 |  22.784 s |   1,492.2 MiB |           267 |
| Constant map only 1              |            3,658 |       7,193 |  39.476 s |   1,392.4 MiB |           267 |
| Constant map only 2              |            3,658 |       7,193 |  14.220 s |   1,485.3 MiB |           267 |
| Control 2                        |            3,663 |       7,203 |  27.427 s |   1,479.7 MiB |           267 |
| Document leaf imports            |            3,653 |       7,183 |  10.500 s |   1,498.6 MiB |           267 |
| First-use tokenizer construction |            3,663 |       7,203 |  12.854 s |   1,369.4 MiB |           267 |

The constant screen's wall-time median/MAD was 26.848/12.628 s versus the
control's 25.106/2.322 s. Its apparent RSS reduction is also within the noise
rule. Neither that screen nor the one-run document/tokenizer screens proves a
time/RSS improvement. No performance-only source hunk was retained.

## Remaining PluginManager graph

The two controls reproduced exactly 3,663 distinct files and 7,203 evaluations:
3,540 files evaluated twice and 123 once. The probe saw no explicit
`resetModules` calls after runtime construction and before teardown. The suite's
required `jest.isolateModules` case creates a separate registry and reloads
the manager graph to verify reuse of the browser owner and pending boot.
Deleting that case would remove behavior coverage.

The project API imports `PROJECT_KNOWLEDGE_SOURCE_FORMATS` from the ingest
driver. Replacing only that import in memory with the exact same map removed
five files and ten evaluations, 0.14%. The fallback tokenizer and workflow
runtime still loaded through another path:

```text
manager -> context -> api/index -> workspace-api -> workspace/bot-run
  -> bot-integration-binding -> integrations/events -> trigger-bridge
  -> execution-authority -> orchestrator -> built-in workflow nodes
```

`bot-integration-binding` imports the pure `readJsonPointer` helper from the
events runtime, which also imports trigger dispatch. There is an independent
direct orchestrator import in `workflow-author-api.ts`. The orchestrator
imports built-in nodes for their registration side effects. Moving one helper
does not cut every path to that runtime.

Another observed path reaches chat option building:

```text
manager -> context -> api/index -> connectors-api -> connectors/bus
  -> commands/dispatch -> commands/goal -> goal-headless-runner
  -> claude/build-options
```

The document screen replaced the project API's `@cognia/document` barrel with
the existing `support-matrix` and `document-structure` leaves. It removed ten
files and twenty evaluations, 0.28%. Both import screens are below the declared
threshold. Their single-edge results explain why further leaf substitutions
alone are a low-priority performance strategy for this workload.

The useful larger seam is execution loading: `runWorkflow`, trigger dispatch,
and the headless goal driver already execute asynchronously. Any implementation
must preserve initialization order: built-in executor registration currently
happens through an import side effect and establishes host ownership before
plugins register conflicting node kinds. Delaying orchestration without
preserving that contract could alter which executor wins. Permission checks,
knowledge ACLs, PII gates, and error handling must remain in the call path.

## First-use tokenizer screen

`lib/ai/tokens/fallback-estimator.ts` runs `new Tiktoken(cl100kBase)` at module
evaluation. The profile attributed 297.846 ms and 221.850 ms of self time to
its two evaluations in the controls.

An in-memory variant retained the static rank imports and every estimator
branch, but constructed the encoder only before the first exact `encode` call.
The manager still passed all 267 tests. Its tokenizer module self time was
11.260 ms across two evaluations; total module counts were unchanged. This is
an attribution result, not an end-to-end speed or memory guarantee.

The estimator's six existing tests passed with the Jest overlay. Its native
worker test reads the untouched source from disk, so a separate executable
check imported a temporary copy of the variant as well. That check verified:

- Empty input and valid provider-reported usage leave the encoder uninitialized.
- A 2.5 MB pathological input uses the existing bounded heuristic without
  initializing the encoder; the observed call took 42.940 ms under its 500 ms
  guard.
- Ordinary exact inputs still produce cl100k counts of 2, 2, and 1 for the
  existing Latin fixtures, and the first exact request initializes the encoder.

This is a small candidate for a proper implementation experiment. A production
change should add a deterministic first-use construction test and then repeat
the full manager comparison with enough samples and the declared noise rule.

## PTY fixture cache: excess invalidation and missing invalidation

`scripts/build/bundle-tui-fixture.mjs` scans `cli/src`, `lib`, `types`, and
`scripts/build`. The extension filter includes test files. Although its
comment mentions `packages/*/src`, those directories are absent from the
actual source-root list.

The cache screen overrode stat metadata only inside a disposable process. It
made the existing bundle virtually newer than all sources, then made one file
newer than that bundle. No source file or real mtime was touched.

| Virtual change                                  | `isStale()` | Interpretation                                          |
| ----------------------------------------------- | ----------- | ------------------------------------------------------- |
| No newer input                                  | false       | Control                                                 |
| `cli/src/tui/pty/terminal-screen.test.ts` newer | true        | An unrelated test edit forces a fixture rebuild         |
| `packages/agent-acp/src/client.ts` newer        | false       | A bundled package input does not invalidate the fixture |

The fixture-only emitted JavaScript closure contains a source marker for that
ACP client, so the last case concerns an actual fixture dependency. The
conservative closure scan found 2,338 JavaScript files / 62,486,609 bytes for
the PTY entry, with no missing literal-relative module references.

A full fresh check made 12,876 stat calls. Ten warm scans had a median of
approximately 73 ms in the corrected probe. That scan itself is small relative
to a rebuild, but it repeats per suite/runtime. The harness's module variable
memoizes a fixture path only within one Jest module registry. The important
fix is a complete input contract, not merely widening or shortening a timer.
Those scan timings include the metadata shim overhead and are attribution
measurements rather than a production-cache benchmark.

## Local build preparation and generated generations

Both CLI bundle suites invoke `scripts/test/cli-bundle.mjs ensure` in
`beforeAll`. Without `COGNIA_JEST_CLI_BUNDLE`, `ensureCliBundle` always calls
the build pipeline. A real local invocation, with existing caches and generated
outputs, completed successfully:

| Stage                             | Measured time |
| --------------------------------- | ------------: |
| Browser built-in plugin build     |       2.067 s |
| CLI JavaScript build and staging  |       6.499 s |
| Whole preparation command         |       8.780 s |
| Peak preparation process-tree RSS |   2,135.0 MiB |

The build has child processes outside the Jest worker's own heap. An
after-suite worker heap recycling limit does not bound this peak. This is one
preparation run, not a repeated estimate of build performance.

CI already has an exact-artifact prepare/restore/verify path; it is not missing
that optimization. The local path can reuse the existing seam, but an unchanged
`HEAD` is insufficient in a dirty tree. Reuse needs actual inputs, generated
plugin state, build configuration, platform, Node/runtime dependencies, and
concurrent publication covered by the cache identity. It must not bypass the
shipped-artifact checks or relabel edited sources as an exact-SHA CI artifact.

Before that build, `cli/dist/chunks` held 122,225 files / 3,242,538,677 bytes
(about 3.02 GiB). After it, the directory held 124,086 files / 3,302,938,529
bytes: 1,861 additional files and 60,399,852 additional bytes. The build writes
hashed generations into the shared directory without pruning older chunk
generations. CLI and PTY outputs share that directory.

A conservative literal-relative JavaScript traversal from the two pre-build
entry files found 5,101 files / 130,563,581 bytes, with no missing references.
This is not a deletion manifest: additional entry points, generated assets,
computed references, and readers still using old generations need explicit
ownership. The whole chunk directory is not evidence that all of its bytes
are resident in memory. No RSS effect from removing historical chunks was
measured, and no chunk was deleted.

Future output cleanup should use isolated generation ownership and complete
build manifests, preserving each active CLI/PTY reader. A blanket cleanup of
the shared output directory would be unsafe during concurrent work.

## Startup cost and verification boundary

The ordinary terminal helper passed all 14 tests in both unprofiled invocations:

| Selection         | Wall time | Peak tree RSS | JSON test-file interval |
| ----------------- | --------: | ------------: | ----------------------: |
| Default projects  |   7.473 s |   1,051.7 MiB |                 0.050 s |
| Node project only |   5.269 s |     706.2 MiB |                 0.063 s |

These single samples are exploratory, not proof of a project-selection speedup.
The separate profiled helper loaded just 73 modules. Process launch,
configuration, discovery, environment setup, and shutdown account for most of
this tiny invocation; the recorded test interval must not be equated with
total runner cost. Narrower selection remains explicit and does not replace
default/CI validation.

All research test runs exited 0, with no skipped cases: 267 manager tests per
run, 14 terminal-helper tests per run, and the six estimator tests. The actual
CLI preparation build also exited 0. Source overlays affected only temporary
Jest processes; the standalone estimator copy lived in the ignored research
directory. Nine monitored repository source/config hashes remained unchanged.
Normal CLI/plugin generated outputs were written by the measured build.

Only this report and its compact data file were added as durable research
artifacts. The research did not rerun full repository typecheck/lint, the full
test inventory, coverage, remote CI, application static export, native packaging,
or UI E2E. Historical coding-loop/typecheck failures from the prior phase are
not asserted as a current status here. No commit or cache deletion was made.

## Authorized fixes and verification

The follow-up implementation fixes the four concrete cache/initialization issues.
It preserves the existing production CLI build location, synchronous token API,
workflow/connector bootstrap order, default Jest projects, CI selection, and
strict exact-SHA artifact verification. No tests or assertions were removed.

- PTY preparation now fingerprints the actual esbuild input closure, including
  workspace packages, configuration, install state, and output bytes. Editing
  an existing unrelated test does not rebuild; a same-mtime package edit does.
- Local CLI suites reuse the same content-verified JavaScript generation. The
  built-in plugin preparation still runs before validation so plugin-source
  edits cannot be hidden behind a stale generated catalog. Missing/modified
  chunks, added output files, mode changes, options, and inputs invalidate reuse.
- CLI and PTY outputs live in separate immutable generations under
  `.cache/jest/test-bundles-{cli,pty}/generation-UUID/cli/dist/`. The shallow
  `cli/dist` layout preserves CLI dependency lookup, dev-checkout recognition,
  package version lookup, and fixed-depth managed-runtime resource lookup.
  Existing bounded sidecar/grammar walks can still reach the repository root.
- Writers serialize across processes. A dead writer's lock is atomically
  renamed to a permanent nonempty UUID tombstone so stale waiters cannot remove
  a newer lock. Reader PID leases retain active generations. Collection removes
  only obsolete generations bearing this cache's ownership marker with no live
  reader. A failed rebuild preserves the published generation. Historical
  shared `cli/dist/chunks` files were retained because other CLI processes may
  still reference them; tests stop adding generations there.
- Tiktoken construction occurs once on the first bounded exact estimate. Empty
  input, authoritative provider usage, and large/pathological heuristic input
  do not construct an encoder. Exact counts remain `2 / 2 / 1` for the original
  Latin fixtures, and the large-upload guard remains intact.

The new `test-bundle-cache.mjs` owns cross-process generation publication and
reader lifetime. The existing `esbuild-input-cache.mjs` remains the shared
fingerprint implementation; frontend generators do not acquire Jest lifecycle
behavior. Its new co-located test and the previously untested PTY bundler's
co-located test are included by the existing `scripts:test:build` glob and full
quality CI. No new dependency or CI lane was introduced.

### Fresh measurements

The predeclared contract, exact pre-edit source snapshots, raw logs, resource
samples, and compact `summary.json` are retained in the ignored directory
`.cache/test-resource-fixes-2026-10-20/`. The compact summary is also included
under `fixes` in the linked durable data file. macOS arm64, Node 26.5.0, same
checkout and dependency state; process-tree RSS sampled every 200 ms.

`node scripts/test/cli-bundle.mjs ensure` ran ten times before and ten times
after, sequentially. Warm statistics exclude the first invocation in each
group (nine samples per group); no shared cache was cleared.

| Repeated preparation metric  |    Before median (MAD) |   After median (MAD) |                       Change |
| ---------------------------- | ---------------------: | -------------------: | ---------------------------: |
| Wall time                    |      4.553 s (0.195 s) |    1.414 s (0.062 s) |                       -68.9% |
| Peak process-tree RSS        | 2,181.1 MiB (49.6 MiB) | 220.8 MiB (13.8 MiB) |                       -89.9% |
| Maximum descendant processes |                      3 |                    2 | One compiler process avoided |

Both repeated-preparation gains exceed the 10% practical threshold and three
times the pooled MAD. This proves the warm preparation improvement, not a
whole-test-suite or cold-build speedup. The first new isolated build still cost
**9.243 s / 2,499.6 MiB**, versus the first baseline invocation's
**5.886 s / 2,205.8 MiB**. New generations pay compilation and fingerprint
publication cost; this implementation does not claim to improve that path.

Across ten optimized invocations, the shared chunk directory stayed exactly
**124,086 files / 3,302,938,529 bytes**. Local cache generations are collected
once obsolete readers have exited. Only obsolete outputs created by this
turn's discarded initial layout were explicitly cleaned; no historical shared
CLI chunks or unrelated caches were deleted.

Ten fresh-process tokenizer probes per version measured import medians of
151.18 ms before and 35.38 ms after. The first exact call moved from 1.02 ms to
100.74 ms: construction is deferred, not removed. Provider/empty/large-input
results and exact counts match in all samples. These probes ran during other
verification activity and are attribution evidence, not an isolated startup
speedup claim. Three unprofiled manager-suite samples per version retained all
267 tests; median wall/RSS changed from 9.613 s / 1,520.8 MiB to
9.270 s / 1,402.7 MiB. With only three samples and a small wall-time difference,
no manager-suite performance claim is made.

### Verification and remaining gates

- Manager, Stop, and estimator: **3 suites / 651 tests passed**.
- The final PTY basics rerun passed **7/7** after the last cache fix. Default
  discovery lists **11,889** paths and retains both CLI bundle suites and all
  PTY suites; this turn does not edit the project selection configuration.
- Build/cache/input-fingerprint contracts: **42 tests passed**, including a
  real esbuild workspace fixture, concurrent crashed-writer recovery, active
  reader retention, output tampering, failed rebuild, CLI path compatibility,
  and a manifest edited during layout preparation.
- Runner/configuration/CI plus build/cache batch: **101 tests passed** before
  the final concurrent-manifest regression was added; the 42-test focused batch
  subsequently passed with that additional regression. Existing strict CI
  identity, transfer, digest, mode, and no-silent-rebuild assertions remain.
- Real build/PTY projects: **12 suites / 81 tests passed; one suite / two tests
  failed**. All ten PTY suites, the CLI entry suite, and Markdown build suite
  passed. The two OpenAI coding-loop failures are the same ToolSearch/catalog
  fixture failures reproduced before this implementation; Anthropic and the
  explicitly authorized terminal path passed. Production tool advertisement
  limits and the failing assertions were retained.
- Scoped ESLint and formatting passed. `pnpm lint:i18n` and
  `pnpm i18n:sort:check` passed. PII, wiring/test inclusion, and runtime/cache
  reviews found no remaining findings after fixes.
- Full `pnpm typecheck` exited 2 on
  `components/harness/harness-failure-offer.test.tsx:86` (TS2698) and
  `components/harness/harness-snapshot-diff.test.tsx:4` (TS2459).
  Full `pnpm lint` exited 1 with 81 errors / 4,856 warnings, chiefly generated
  `src-tauri/resources/plugins/cognia-office/dist/index.js`, plus findings in
  other out-of-scope files. Neither repository-wide gate is claimed green.

Coverage collection, remote CI execution, application static export, native
packaging, and UI E2E were not run. This change does not defer workflow/connector
execution or alter plugin registration/permission order; that larger graph
boundary still needs its own behavioral integration proof. No commit was made.
