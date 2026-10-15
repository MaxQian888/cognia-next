# Next CI optimizations: primary-source guidance

Date: 2026-10-15 (Asia/Shanghai). Scope: six candidate optimizations to map against measured repository costs. This report does not change workflows or claim benchmark savings. The parent audit owns local workflow evidence; previously completed same-SHA CLI artifact reuse and Rust release-cache work are not proposed again here.

## 1. Make prerequisite edges represent actual prerequisites

**Verified behavior.** GitHub `needs` waits for successful completion of named jobs. Failure or skipping propagates to dependent jobs unless their condition permits continuation. Job outputs can carry a selection plan to downstream jobs. [GitHub job dependencies](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs), [passing job outputs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs).

**Candidate.** Keep an inexpensive changed-scope planner before dependency installation, then let independent lint, unit, Rust, and build producers start from only their actual prerequisites. An E2E consumer should wait for its required build, not every unrelated quality job. Preserve an aggregate merge gate that waits for all selected checks and explicitly rejects their failures.

**Limit and measurement.** Earlier parallel starts can waste runner minutes when another gate soon fails. Compare critical-path duration and total runner minutes together. Do not remove a real generated-file, artifact, or setup dependency merely to shorten the graph. Explain planned skips separately from upstream failures.

## 2. Remove repeated installation work only after separating its components

**Verified behavior.** `setup-node` caches package-manager data, not `node_modules`. The repository's **pnpm 11.18.0** help confirms workspace-wide installation, frozen-lockfile validation, `--prefer-offline` fetching missing data, `--offline` failing for absent store content, and `--ignore-scripts` disabling lifecycle scripts. Current official documentation explicitly includes both project and dependency scripts. The nominal `/11.x/` documentation URL redirects to current documentation, so these core options were also checked with the installed version's read-only `install --help`. [setup-node caching](https://github.com/actions/setup-node#caching-global-packages-data), [pnpm install](https://pnpm.io/cli/install).

**Candidate.** Split observed install time into download/store restore, linking, native dependency setup, and root lifecycle generation. If an expensive root hook regenerates outputs already produced explicitly for each job, first make those required outputs an explicit job prerequisite and then scope when that hook runs. Keep normal install for consumers whose native modules or generated sources depend on lifecycle scripts.

**Limit and measurement.** A cache hit does not authorize skipping install. Blanket `--ignore-scripts` can remove required native builds and code generation. Measure cold and warm runs before distributing a large installed dependency tree: artifact transfer, platform-specific modules, symlinks, Node ABI, and lifecycle side effects can cost more than a local store-backed install.

For Docker-layer candidates specifically, pnpm **11.18.0** `fetch --help` confirms fetching into the virtual store from the lockfile while ignoring package manifests. It also labels the command experimental and warns that non-major releases may break behavior. Current official documentation describes workspace configuration/patch inputs and warns that local `file:` dependencies are skipped; verify that edge case against 11.18.0 before relying on it. Follow fetch with a validated install. This is not a substitute for installed dependencies in an arbitrary test job. [pnpm fetch](https://pnpm.io/cli/fetch).

## 3. Choose artifact compression for the actual payload

**Verified behavior.** `upload-artifact` supports compression levels 0–9, default 6, and recommends 0 for large poorly compressible data. Higher compression trades CPU time for size. Its zipped uploads do not preserve executable modes; a tar container preserves the original filesystem metadata. [Official upload-artifact documentation](https://github.com/actions/upload-artifact#altering-compressions-level-speed-v-size), [permission behavior](https://github.com/actions/upload-artifact#permission-loss).

**Candidate.** Use level 0 for already-compressed archives and benchmark binary artifacts before applying it broadly. Keep compression for text-heavy reports/build trees when transfer size dominates. Avoid uploading both a compressed archive and its expanded duplicate unless a consumer needs both. Preserve executable permissions through a suitable tar wrapper for binary consumers.

Separate small result manifests/JUnit from bulky coverage payloads when consumers need different subsets. A timing or comparison report should download only the artifact family it reads. This targets unnecessary transfer without changing coverage collection or its denominator. Any later change to per-shard global coverage enumeration needs a separate correctness design preserving the final repository-wide denominator.

**Limit and measurement.** A raw Rust executable can still compress substantially; “binary” does not mean incompressible. Compare archive preparation, upload, aggregate consumer download/extraction, and retained bytes. Pin behavior to the action version already used; new options in live documentation are not automatically available in older pinned majors.

## 4. Audit Rust invalidation and cache writers before adding another cache

**Verified behavior.** `rust-cache` keys include compiler/environment inputs and supports a shared key, extra key, cache workspace/target configuration, and conditional saving. Its documented defaults favor dependency artifacts and disable Cargo incremental compilation; opting into workspace-crate caching is a separate setting. [rust-cache maintained README](https://github.com/Swatinem/rust-cache).

Cargo build scripts default to broad package-file invalidation. `rerun-if-changed` and `rerun-if-env-changed` narrow it to declared inputs; omitting an actual input from such a declaration can prevent necessary regeneration. [Cargo build-script change detection](https://doc.rust-lang.org/cargo/reference/build-scripts.html#change-detection).

**Candidate.** For repeated debug/test compilation, inspect which dependencies and build scripts rebuild after a warm restore. Model the complete closure: workspace manifests/lockfile, toolchain, target architecture, profile, features, Rust/C flags, native toolchain, schema/codegen files, and build-script environment. Share dependency caches only across compatible jobs; consider one writer and other readers when identical writers upload redundant data.

**Limit and measurement.** GitHub caches are immutable by key and restore prefixes may return older compatible candidates. A restore hit is not evidence the binary is current: Cargo still validates/rebuilds. A workspace-source cache that excludes source changes from its key may repeatedly restore an old state without saving the rebuild under a new key. Do not hash every source into dependency-only caches or broadly share incompatible profiles merely to increase hit rate. Measure restore/save bytes and time as well as actual compilation time. [GitHub cache matching and immutability](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

## 5. Extend build-once/test-many only across compatible consumers

**Verified behavior.** Playwright can launch a server from a configured command and check a readiness URL. Its documented CI convention is `reuseExistingServer: false` through `!process.env.CI`; reusing a live server is not the same as reusing a build. [Playwright webServer](https://playwright.dev/docs/test-webserver).

**Candidate.** Where multiple browser jobs build the same frontend with identical inputs, produce one immutable build artifact and have each consumer launch a fresh isolated server from it. Record source SHA, build mode, relevant environment/configuration and artifact identity; retain each consumer's own state, ports and test data. Preserve the existing distinction between production/static-export acceptance and dev-server-specific checks.

**Limit and measurement.** A single build cannot replace consumers requiring different compile-time environment, feature flags or output targets. Compare producer queue time plus build/upload/download against each consumer's eliminated build; adding a central producer can lengthen the critical path for small suites. Do not enable reuse of an arbitrary existing CI server as a shortcut.

For browser setup, first install only browsers actually exercised. Playwright discourages browser caching by default because restore time can match downloading and Linux OS dependencies still need installation; if retained, key browser caches to the Playwright version. [Playwright CI browser cache guidance](https://playwright.dev/docs/ci#caching-browsers), [Playwright browser download guidance](https://playwright.dev/docs/best-practices#optimize-browser-downloads-on-ci).

## 6. Cancel superseded PR computation without losing change coverage

**Verified behavior.** GitHub concurrency groups can cancel running work with `cancel-in-progress`; workflow-specific group names prevent unrelated workflows from cancelling each other. Conditions can limit cancellation to selected event/branch classes. [GitHub concurrency syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).

**Candidate.** Cancel obsolete checks for the same PR while preserving intended deployment/release serialization. Keep event, workflow and PR/ref identity in the group design. Continue computing PR selection from the full relevant base-to-head range rather than just the newest commit. For mainline incremental work, use the last successfully validated base so a cancelled intermediate run does not leave untested changes behind. Nx documents that distinction for CI base selection. [Nx affected base commit](https://nx.dev/docs/kb/affected-base-commit).

**Limit and measurement.** Cancelling work is a scheduler policy, not test-result reuse. Required checks still need the current validated revision, and deployment cancellation may interrupt side effects. Measure saved obsolete-run minutes, current-head queue delay, fallback frequency and cancelled-run prevalence. Preserve a force-full recovery route when history or a trusted successful base is unavailable.

## Evaluation order

First inspect job wait/setup/lifecycle/upload/restore timings. Select the lowest-risk demonstrated bottleneck, change one mechanism, and compare the same workflow/event/runner/input class. Record both elapsed merge-gate time and summed runner minutes, plus cold/warm behavior and correctness failures. The source material supports these mechanisms; it does not establish that all six improve this repository or justify a new test-runner/build-system migration.

## Follow-up: retain lint/format caches after ordinary validation failure

**Finding.** This is a viable targeted candidate, rather than a deferred unknown, provided the original failing exit status remains a gate failure. ESLint has cached results containing lint errors since v5.2; it is not a successful-files-only cache. Its current result-cache implementation restores valid cached diagnostics. Prettier's current CLI saves entries when input already matches formatted output and removes entries for unformatted input; cache reconciliation happens before the final formatting-failure exit status. [ESLint release note](https://eslint.org/blog/2018/07/eslint-v5.2.0-released/), [ESLint result-cache source](https://github.com/eslint/eslint/blob/main/lib/cli-engine/lint-result-cache.js), [Prettier CLI source](https://github.com/prettier/prettier/blob/main/src/cli/format.js).

**Local bounded verification.** An isolated temporary-directory fixture used installed ESLint **9.39.5** and Prettier **3.9.9**, with one good and one bad file, running each tool twice with an explicit cache path. ESLint returned `1` both times; the second run skipped re-linting both unchanged files but still reported the cached error. Prettier `--check` returned `1` both times; its cache contained the good file and excluded the unformatted one. The temporary files were removed automatically. No repository source or test suite was changed or run.

**Save policy.** The official standalone `actions/cache/save` documentation explicitly supports saving after earlier step failures with a status condition and recommends checking the restore hit and reusing the primary key. A save step can therefore run after a completed ordinary lint/format failure while leaving that validation step failed. Prefer a non-cancelled, executed-check, existing-cache condition and exclude exact cache hits; do not mask exit codes with `|| true` or make validation `continue-on-error` solely to save its cache. Retain trusted writer scope. A crash, timeout, configuration failure or absent cache needs separate handling, not an unconditional claim that a complete useful cache was generated. [actions/cache/save](https://github.com/actions/cache/blob/main/save/README.md#always-save-cache).

**Invalidation limits.** Both tools warn that plugin changes require external invalidation. Include lockfile/tool/plugin/configuration/custom-rule inputs in the cache compatibility key. Use content-based file invalidation across checkouts. For rules that inspect imported types or external files, include their dependency closure or disable result reuse for that rule set; a file-content cache does not automatically cover arbitrary external inputs. Prettier documents version/options/content keys and plugin limitations; ESLint explicitly warns that upgrading plugins does not clear its cache. [Prettier CLI cache](https://prettier.io/docs/cli.html#--cache), [ESLint cache API](https://eslint.org/docs/latest/integrate/nodejs-api#-new-eslintoptions).

The benefit to measure is warm-run lint/format duration even while unrelated violations remain. This improves feedback cost; it does not repair those violations or justify reporting the gate as passing.

## Sources

The official documentation and maintained action repositories linked above were consulted on 2026-10-15. pnpm core install/fetch behavior was cross-checked with installed **11.18.0** CLI help because the official `/11.x/cli/install` and `/11.x/cli/fetch` URLs redirected to current documentation. Live GitHub/Playwright/Cargo/action documentation must likewise be reconciled with pinned versions before implementation. Apart from the bounded temporary lint/format cache fixture described above, no code, workflow, dependency, benchmark, full-suite run or coverage run is included in this research-only change.
