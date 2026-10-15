# Remaining CI and release optimization opportunities

Date: 2026-10-15 (Asia/Shanghai).

## Scope and decision

This is a research-only follow-up. It combines current working-tree source inspection, historical GitHub Actions job/log data, official documentation, and a bounded temporary ESLint/Prettier cache experiment. No workflow or application source was changed, and no full test, coverage, build, release, or deployment was dispatched for this audit.

The earlier local changes already address shallow-clone planning, affected Quality selection, same-SHA Jest CLI artifact reuse, release Rust dependency caching, and the Ajv JSON import failure. They remain uncommitted; this report does not propose them again or claim they have passed hosted CI.

The next performance batch should restrict report downloads and allow useful lint/format caches to survive ordinary validation failures. In parallel with that priority, fix the release SDK prerequisite gap before the next release. Then separate early impact decisions from Jest artifact production, and narrow setup prerequisites using the existing gate registry. Broader cross-platform or cross-run output reuse needs more evidence first.

## Measured costs and limits

The two main CI samples are runs [38561507260](https://github.com/MaxQian888/cognia-next/actions/runs/38561507260) and [38554946592](https://github.com/MaxQian888/cognia-next/actions/runs/38554946592), created on 2026-10-14. The first tested committed SHA `f3b0e5ca9fa9dc1930156564a3939be60f09ff3c`; the second tested an earlier commit. Both failed during planning. They establish costs of executed steps, not a healthy end-to-end baseline or the benefit of the local fixes.

| Observation                                                                         | Evidence                                                                                                                                                                                           | Interpretation                                                                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Report baseline download: 52 seconds, 66 artifacts, 2,400,606,155 reported bytes    | [Report job 115850209343](https://github.com/MaxQian888/cognia-next/actions/runs/38563492338/job/115850209343)                                                                                     | None of those baseline artifacts supplied an input read by the report. This is confirmed unnecessary transfer.                             |
| Report job: 147 seconds total; root install 25 seconds; report generation 4 seconds | Same report job                                                                                                                                                                                    | Setup and transfer dominate useful report execution. Setup Node also restored roughly 1 GB of package-store cache.                         |
| Eleven Quality root-install steps: 540 and 546 seconds summed across jobs           | Two main CI runs                                                                                                                                                                                   | Approximately 9 runner-minutes per run, not 9 minutes of wall-clock delay. Only the unnecessary lifecycle work is a candidate for removal. |
| Jest runtime prerequisite build: 84 and 81 seconds                                  | Planner jobs in the same two CI runs                                                                                                                                                               | Early independent runtime decisions currently wait behind this preparation.                                                                |
| Lint command: 537.4 seconds; format check: 514.6 seconds; both failed               | [Lint job](https://github.com/MaxQian888/cognia-next/actions/runs/38561507260/job/115843695924), [format job](https://github.com/MaxQian888/cognia-next/actions/runs/38561507260/job/115843695942) | Failed runs currently skip cache-save steps; these are observed costs, not predicted cache savings.                                        |
| Web image job: 1,900 seconds; Docker build step: 1,826 seconds                      | [Images run 38561508832](https://github.com/MaxQian888/cognia-next/actions/runs/38561508832)                                                                                                       | Worth profiling later. The build step includes cache/transfer work and cannot be called compilation time alone.                            |

Artifact sizes above come from download logs and are not measured network wire bytes. The report baseline consisted of 64 `jest-shard-*` artifacts (2,383,223,723 bytes), a test plan (285,653 bytes), and runtime prerequisites (17,096,779 bytes). The baseline reader only uses coverage-report, Playwright JSON, and bundle metrics; none was present in that set.

Raw evidence is retained locally under `/Users/bytedance/.codex/visualizations/2026/10/15/01a13d98-e302-7a73-a864-6ab6b046bb80/ci-next-audit/`, including job JSON, logs, the download summary, and recent run metadata. The GitHub links provide the portable evidence entry points.

## Priorities and acceptance

### P0: Repair release SDK inputs and establish a trusted green baseline

The fresh `publish-agent-sdk` job invokes the raw CLI builder through `agent:sdk:smoke`, without receiving native helpers or preparing webclone. Its later pack check omits `--require-host`, allowing the default-host test leg to be skipped when the local host package is absent. This is a source-confirmed wiring gap, not a newly reproduced hosted failure. Supply verified same-run inputs and require the host pack test. Keep the Node RPC crash-recovery smoke and Bun/native host smoke distinct; neither proves the other's behavior. See the [release audit](2026-10-15-ci-release-reuse-followup.md#1-sdk-publication-starts-without-the-nativeruntime-inputs-its-smoke-requires).

Separately, all ten sampled recent main CI runs from 2026-10-13 through 2026-10-14 had failed. The local [push-baseline policy](../../scripts/ci/change-plan.mjs) requires a successful CI push run for the exact preceding SHA; otherwise it selects `unverified-push-baseline` full mode. Therefore persistent red CI can prevent incremental push savings even after the planner is repaired. This is an inference from current policy and historical results, not evidence that the local planner ran on GitHub. Restore a trusted green run and expose fallback reasons; do not remove this safety rule to improve the apparent incremental rate.

Acceptance: a clean release checkout executes every intended smoke/package leg; missing inputs trigger a complete build or a blocking failure. A successful predecessor permits incremental push planning, while failed, cancelled, missing, forced-push, and untrusted baselines retain conservative behavior.

### P1: Restrict report dependencies and artifact downloads

[report.yml](../../.github/workflows/report.yml) currently downloads every artifact for both current and baseline runs and installs the complete application workspace. The report's only external module dependency is `istanbul-lib-coverage`; its JUnit parser is local and dependency-free.

First allowlist the actual artifact families. Current results need JUnit, Playwright JSON, coverage, and bundle metrics; baseline comparison needs only the last three. Handle legitimately absent categories explicitly. Provide a lockfile-controlled report dependency boundary that does not trigger application sidecar builds. Next, separate small JUnit/timing result artifacts from bulky coverage maps so report readers do not fetch per-shard coverage unnecessarily.

Acceptance: archived successful, failed, incremental-without-coverage, and missing-baseline inputs produce equivalent reports; root application builds are zero; download logs include only consumed categories. Preserve the base-repository `workflow_run` trust boundary, actual triggering conclusion, and missing-data labels. Never substitute baseline coverage for absent current coverage. Details: [setup audit](2026-10-15-ci-setup-reuse-followup.md#5-give-the-report-workflow-a-small-dependency-boundary-and-an-artifact-allowlist).

### P1: Save useful caches after completed lint/format failures

[quality.yml](../../.github/workflows/quality.yml) saves trusted trunk lint/format caches only after preceding steps succeed. An ordinary validation failure therefore loses useful cache work. A temporary fixture using installed ESLint 9.39.5 and Prettier 3.9.9 verified that repeated cached checks still return exit code 1 for violations. ESLint replays cached errors; Prettier caches the formatted file and rechecks the unformatted one.

Allow saving when the check actually completed, a cache exists, the run was not cancelled, and the trusted writer/key conditions hold. Preserve the validation failure. Include plugin/custom-rule/configuration inputs in compatibility keys and account for rules whose result depends on external files. A crash, timeout, or configuration error is not evidence of a complete cache. Details and official sources: [cache semantics](2026-10-15-ci-next-optimization-primary-sources.md).

Acceptance: cold and warm checks report the same violations and nonzero exit; changed rule/config/plugin inputs invalidate appropriately; cancelled or incomplete runs do not publish misleading cache state. Measure warm duration rather than assuming the observed eight-to-nine-minute checks disappear.

### P1: Let independent jobs start after the early impact decision

Nineteen job definitions in [test.yml](../../.github/workflows/test.yml) directly depend on `jest-plan`. That job resolves changes early but finishes only after dependency installation, prerequisite builds, test inventory, and selected CLI/native preparation. PostgreSQL and standalone Rust checks do not need the Jest inventory or CLI artifact.

Move the existing pure impact classifier into the shared dependency-free planning boundary. Independent jobs consume its outputs; actual artifact consumers retain producer dependencies. Do not duplicate path classification rules in YAML. Preserve the Windows Tauri dependency on a real production export.

Acceptance: impact decisions match existing fixtures; unrelated jobs become runnable before Jest preparation finishes; selected failures still fail the aggregate gate. Measure critical-path duration and total runner-seconds separately, since earlier parallel starts can increase wasted work on failing runs. Details: [early planning](2026-10-15-ci-setup-reuse-followup.md#1-publish-runtime-impact-decisions-before-preparing-jest-prerequisites).

### P2: Match setup and prerequisite artifacts to their actual consumers

Affected Quality selection is already implemented, but surviving groups still run the broad root postinstall chain. Every Rust-marked group receives desktop GTK/WebKit packages. All Jest shards download combined runtime prerequisites and install webclone before reading their own selected test lists.

Extend the existing gate registry with prerequisite capabilities and derive setup from selected gates. Begin with narrow proven cases such as desktop libraries versus `cargo deny`, report-only dependencies, and standalone Workers. Then evaluate per-shard runtime components and extension-host/A2UI artifact reuse. Retain complete setup for unknown consumers. Repeated build-driver calls are not proof of repeated compilation because some already have local freshness fast paths.

Acceptance: clean checkouts execute the same gate/suite inventory; missing required outputs fail or rebuild; actual compiler invocation counts decrease. Cross-checkout reuse must validate source/config/lockfile/runtime digests and output closure rather than filesystem mtimes. Compare transfer and verification costs against avoided compilation. Details: [setup and reuse audit](2026-10-15-ci-setup-reuse-followup.md).

### P2: Improve release and deployment handoffs after defining their contracts

The [release audit](2026-10-15-ci-release-reuse-followup.md) identifies four further candidates:

- Signaling/share Dockerfiles copy application sources before their single Rust build. Apply the repository's existing cargo-chef dependency-layer pattern, then measure unchanged, source-only, dependency-change, and cold-cache builds.
- Fly source deployments rebuild the service Dockerfiles used by the image workflow. Consume a verified matching-SHA image digest when registry access and architecture permit, retaining source-build fallback and health checks.
- Tauri runs the frontend build across four targets. Share only a proven portable static export with explicit timestamp/platform/environment inputs; retain target-native resources, signing, and notarization.
- GitHub release visibility currently precedes completion of CLI/SDK publication, and image tag publication runs independently. If visibility represents the complete product, promote only after all required checks/producers succeed; build in parallel and promote tested bytes. If products intentionally release independently, document that boundary.

Start with same-run artifact handoff. Cross-run reuse needs producer trust, exact SHA, toolchain/target/profile/configuration identity, payload integrity, and signing-state validation. Existing full/slim Bun compilation, npm host layout copying, shared server-image stages, and digest-based agent-image smoke already avoid duplication and should be retained.

## Defer coverage collection changes until equivalence is demonstrated

Large per-shard coverage artifacts suggest inspecting global source enumeration, but artifact size alone does not quantify duplicate computation. A future design could produce the zero-coverage source universe once and merge executed maps. It must preserve file, branch, function, statement, and threshold semantics, including files never imported by a test. Simply removing `collectCoverageFrom` would shrink the denominator and could hide missing tests. Split report/result payloads first; this is lower risk and requires no coverage-policy change.

## Verification plan for implementation

For each accepted batch, record selected/executed gate and suite identities, cold/warm setup duration, actual build invocations, artifact bytes, cache restore/save time, total runner-seconds, and critical-path elapsed time. Compare equivalent SHA, event, selection mode, runtime, and runner conditions. Include corrupted/missing/wrong-SHA artifact cases and normal cache-miss fallback. Keep full nightly/release checks and fail on real assertion or smoke errors.

This audit created four Markdown reports. Source checks and the bounded cache fixture support the findings; no performance improvement is claimed as implemented or benchmarked. Official documentation and version qualifications are collected in [primary sources](2026-10-15-ci-next-optimization-primary-sources.md).
