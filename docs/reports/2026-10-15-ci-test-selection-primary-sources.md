# CI test selection: primary-source research

Date: 2026-10-15 (Asia/Shanghai). Scope: industry mechanisms and their limits; the companion repository audit owns current Cognia workflow behavior and timing evidence. This is a research artifact, not an implemented CI change. No test suite or coverage command was run for this research.

## Conclusion

Use a conservative affected-work planner, dependency-aware unit-test selection, reusable build results, and an explicit full-suite safety net. These solve different problems. A path-only rule that runs tests beside edited files does not establish the absence of downstream regressions. Installing a monorepo task runner also does not automatically discover every runtime dependency inside one large application.

The baseline recommendation below is an engineering synthesis of the cited capabilities and constraints, not a claim that every vendor recommends the same policy.

## Four separate optimizations

| Mechanism                   | Work saved                                       | Boundary                                             |
| --------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| Affected selection          | Avoids irrelevant projects/tasks/tests           | Depends on complete dependency and input modeling    |
| Task-result caching         | Reuses a prior execution with identical inputs   | Requires deterministic tasks and complete cache keys |
| Dependency/compiler caching | Avoids repeated downloads/transforms/compilation | Does not by itself prove tests passed                |
| Sharding                    | Splits the selected suite across workers         | Reduces elapsed time, not inherently total compute   |

Turborepo documents reuse by input fingerprint and assumes deterministic tasks. Playwright documents distributing suites across machines, with test-level balancing under `fullyParallel` versus file-level distribution otherwise. These are complementary capabilities. [Turborepo caching](https://turborepo.dev/docs/crafting-your-repository/caching), [Playwright sharding](https://playwright.dev/docs/test-sharding).

## Verified tool behavior

### GitHub Actions: avoid invisible or accidentally successful gates

- Workflow-level path filtering can leave a required check pending forever. A conditionally skipped job reports success; a dependent job skipped after an upstream failure may not block merging. GitHub recommends `always()` with `needs` for required dependent checks.
- Required checks must correspond to the relevant latest head or test-merge SHA. A merge queue requires the separate `merge_group` trigger.

[GitHub required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

Path filtering uses three-dot diffs for PRs and two-dot diffs for existing-branch pushes. The current documentation, retrieved on the report date, says a diff beyond **3,000 files** can omit matching files outside that returned prefix; pushes over 1,000 commits or a diff timeout run the workflow regardless. Older references may quote a different file limit. Therefore a top-level path filter is not a complete impact-analysis system. [GitHub workflow syntax: diff comparisons](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons).

**Recommendation:** always trigger the main PR planner and one stable aggregate required check. The aggregate gate must validate the planner and every selected job's result, accepting `skipped` only when the plan explicitly says the job is unnecessary. Do not let a planner crash or missing matrix become a green empty run. If merge queues are enabled, run the same gate against their merge-group revision.

### Jest: appropriate for dependency-aware selection within an application

Jest 30 documents `--findRelatedTests` for an explicit source-file set and `--changedSince` for changes relative to a branch/commit. `--onlyChanged` requires a static dependency graph and cannot generally account for dynamic requires. `--listTests` exposes the selected files without running them; `--runTestsByPath` runs an explicit list. `--passWithNoTests` merely permits an empty result. [Jest 30 CLI](https://jestjs.io/docs/30.0/cli).

**Recommendation:** compute a reproducible change manifest, then select related tests plus directly modified tests and mandatory critical suites. Save the manifest and selected list. Treat an unexplained empty selection for production changes as a full-domain fallback, not automatic success. Global setup, mocks, aliases, resolvers, transforms, schemas, generated sources, and runtime-discovered modules need explicit expansion rules. A source deletion may break dependencies that no longer appear in the head graph; retain old and new paths and expand conservatively for deletions/renames.

### Playwright: `--only-changed` is an early warning, not a sound replacement

Playwright's official CI guide calls changed-test selection a heuristic over the test-suite dependency graph that can miss tests. It explicitly recommends the full suite after the preliminary run. The example fetches non-shallow Git history. [Playwright CI fail-fast](https://playwright.dev/docs/ci#fail-fast), [maintained documentation source](https://github.com/microsoft/playwright/blob/main/docs/src/ci.md).

**Recommendation:** use it only to accelerate first failure initially. For actual E2E reduction, maintain explicit product-domain/project mappings plus a core smoke suite and validate those mappings against full runs. A test that opens a route by URL need not import that route's implementation, so test-file import reachability alone cannot establish application impact. Moving comprehensive E2E to merge queue or scheduled runs is a deliberate detection-latency tradeoff, not a guarantee supplied by `--only-changed`. Keep broad premerge E2E until measured evidence supports the narrower policy.

### Nx: project graph first; task inputs are a separate precision layer

Nx maps Git changes to projects and includes their dependents. Its current v23 documentation describes an optional task-input selection mode, `NX_LEGACY_AFFECTED=false`; omitted inputs/outputs can then omit required work, and ordering edges alone do not propagate impact. Lockfile changes affect all projects by default; an `auto` policy can narrow to resolved dependency changes. These newer capabilities require validating the installed version and graph model before adoption. [Nx affected](https://nx.dev/docs/features/ci-features/affected), [Nx dependency-update policy](https://nx.dev/docs/reference/nx-json#projectsaffectedbydependencyupdates).

Nx distinguishes the PR merge base from the last successful main-branch CI commit: using the latter for mainline runs retains changes whose earlier CI never passed. [Nx CI base commit](https://nx.dev/docs/kb/affected-base-commit).

### Turborepo: package-level selection and explicit task caching

`turbo run ... --affected` defaults to package-level selection and includes affected dependents through its documented filter equivalent. Insufficient history makes all packages affected. Current documentation describes optional task-input selection as an additional feature; do not assume it exists in an older installation. [Turborepo run reference](https://turborepo.dev/docs/reference/run#--affected).

Its CI guidance separates selecting work from restoring cached work. Unmodeled `env`/`globalEnv` values can reuse results from the wrong environment, and incorrect outputs can break restored builds. [Turborepo CI guidance](https://turborepo.dev/docs/crafting-your-repository/constructing-ci).

**Recommendation:** do not migrate the repository to Nx/Turbo merely to add changed-file testing. Evaluate them when multiple meaningful projects/tasks, dependency edges, and repeated deterministic outputs justify the adoption cost. Preserve framework/toolchain/OS/architecture/environment inputs and avoid caching externally stateful acceptance-test results as if they were hermetic unit tests.

### pnpm and Cargo: package selection is useful, but coarse

pnpm 10 documents `--filter "...[<base>]"` to select changed packages and their dependents; a trailing ellipsis selects dependencies instead. `--fail-if-no-match` can expose unexpected empty matches. These selectors choose workspace packages, not individual tests within a package. [pnpm 10 filtering](https://pnpm.io/10.x/filtering).

Cargo supports package and target selection through `-p`, `--workspace`, and target flags. These are execution scopes, not a documented changed-file-to-regression-test mapping. [Cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html).

**Recommendation:** use pnpm for real workspace boundaries and Jest for granularity inside the main application. Use Rust crate/domain gates initially; an arbitrary Rust test-name substring is not dependency analysis. Shared IPC contracts must expand both frontend and Rust checks.

## Proposed conservative baseline

1. **One planner:** record event, exact base/head/merge-base SHAs, complete changed paths, selector version, selected domains/tests, and reasons. Use a verified PR base and head; test the actual integration revision separately when appropriate. For mainline, prefer the last successful relevant validation base so failed/cancelled runs cannot lose changes.
2. **Domain gates:** start with independently deployable/buildable domains. Distinguish prose-only documentation from docs application/configuration changes. Shared contracts and shared build inputs expand all consumers.
3. **Unit tests:** opt eligible JS/TS changes into related-test selection only after shadow validation. Keep broad typechecking/build validation within affected application boundaries until reliable project references or equivalent dependency models exist.
4. **E2E:** initially retain full coverage and use selected tests only for earlier failure feedback. Later reduce PR execution only for audited domain mappings; retain critical smoke, broad merge validation, scheduled complete runs, and an explicit force-full override.
5. **Deployment:** build tested artifacts once and promote the same immutable artifact identity. Change selection may avoid unaffected component deployment; release acceptance and environment health checks remain separate obligations.

Fallback means **run the full affected domain, or the whole repository when the domain is unknown**. It does not mean ignore a selector error. Fall back for missing/unresolvable Git history, incomplete file enumeration, malformed planner output, unknown paths, dependency-graph failures, uncertain deletions/renames, unexplained empty selection, global configuration/setup changes, and unresolved lockfile/manifest effects. If the planner cannot even emit a valid full plan, fail the gate.

## Rollout and acceptance evidence

These are proposed local acceptance criteria, not vendor benchmarks:

- Start in shadow mode: calculate the proposed selection while existing complete suites still run on the same SHA. Compare failures outside the selected set; classify genuine missed regressions separately from known flakes and infrastructure failures.
- Measure p50/p95 first-actionable-result time and complete merge-gate time, total runner minutes, queue/setup/cache-restore time, selected/total test count, full-fallback rate with reasons, cache hit rate, and shard imbalance.
- Record every genuine full-run failure that selection would miss. A reproducible miss blocks expansion of that selector until the dependency/input rule is repaired and replayed against the historical change.
- Test planner behavior using representative history and synthetic rename, delete, lockfile, global-config, cross-language contract, missing-base, large-diff, and no-match cases. This validates selection correctness without running expensive complete suites for every planner unit test.
- Roll out one stable domain first, retain an immediate force-full switch, and compare the same event/runner/suite categories before and after. Do not claim a percentage saving without comparable hosted-run evidence.

## Sources

All links above were opened or verified against their official documentation/source on 2026-10-15. Jest references use version 30 and pnpm references version 10; Nx/Turborepo/Playwright/GitHub pages are live documentation and must be checked against the repository's pinned versions before implementation. No secondary industry survey, benchmark, or paid-tool marketing statistic is used as proof of Cognia performance.
