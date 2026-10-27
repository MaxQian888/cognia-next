# Team/Squad live evaluation — 2026-10-25

The repaired evaluation path completed 90 real runs against `ark-deepseek-v4.1-flash` using the final frozen source: ten text/structured tasks, three repetitions, and three candidates. All candidates solved every task in this small pilot. Parallel coordination reduced Squad latency, while the single-call Agent had the lowest latency and token use.

| Candidate                   | Correct / attempted | Success | Wall p50 | Wall p95 | Input tokens | Output tokens | Total tokens | Tokens / solved |
| --------------------------- | ------------------- | ------- | -------- | -------- | ------------ | ------------- | ------------ | --------------- |
| Single Agent, one text call | 30 / 30             | 100%    | 1.415 s  | 2.850 s  | 2,859        | 4,423         | 7,282        | 242.7           |
| Serial Squad                | 30 / 30             | 100%    | 4.057 s  | 5.627 s  | 12,327       | 9,454         | 21,781       | 726.0           |
| Parallel Squad              | 30 / 30             | 100%    | 2.891 s  | 4.515 s  | 12,327       | 8,921         | 21,248       | 708.3           |

Every candidate also passed all three repetitions on all ten unique tasks. All 90 attempts have measured input/output usage, with no partial or unavailable usage attempts. Reported cache-read and cache-creation tokens were zero. Currency cost is unavailable: the proxy catalog provides no billing rates, and the user explicitly requested comparing token usage instead. These are API-reported tokens, not a reconciled internal invoice.

Across the identical workload, serial Squad wall time summed to 128.782 s, parallel Squad to 92.209 s, and single Agent to 47.579 s. Parallel reduced total Squad wall time by 28.4% and median wall time by 28.7%. Serial and parallel Squads used respectively 2.99× and 2.92× the single Agent's reported tokens. These descriptive results do not show a quality advantage for extra agents on this dataset; the success metric is saturated.

## Measured protocol

- Time: 2026-10-25T00:48:20+08:00 through 2026-10-25T00:52:50+08:00, Asia/Shanghai.
- Endpoint: `http://127.0.0.1:8787/v1`; selected model ID: `ark-deepseek-v4.1-flash`; Chat Completions through the configured OpenAI-compatible provider. A separate fresh preflight returned HTTP 200 and `OK`.
- Runtime: Node v26.12.1, macOS arm64, shared workstation. The bundled pnpm launcher reports its own Node v24 engine warning; the measured Node process is recorded separately.
- Execution profile: `isolated-text`. The single-Agent baseline is one model call. Each Squad has two worker calls for independent x/y subtasks and one dependent final-answer call. Serial limits child concurrency to one; parallel permits two independent children.
- Shared production code: provider resolution/model target, Squad launch admission, the durable coordinator with private in-memory ports, Team task graph synthesis and wave scheduling. The live runner overrides only definition loading; it does not substitute model outputs or usage.
- Fixed schedule: task × candidate × three repetitions, seeded randomized candidate order inside each task/repetition block, seed `20261025`, experiment-level concurrency one. All candidates receive the same task facts and final JSON contract. Decomposition/role/aggregation instructions belong to the Squad configuration.
- Limits: 2,048 output tokens per client call, 32,768 token admission budget per Squad run, 120 s case deadline, no implicit SDK retries. The observed campaign issued 210 client generation calls: 30 single-Agent calls plus 180 Squad call spans. Gateway-internal operations are outside this client-side observation.
- Oracles: parse the final JSON and compare the complete value with an independently retained expected object. Claiming success, malformed JSON, wrong values or extra fields fails. References are not sent to the model. Cases cover arithmetic, sorting, filtering, invoice aggregation, logic, text counts, a small graph, intervals, representation conversion and selection.
- Timing: end-to-end execution wall time, including per-run coordination, provider work and aggregation. Process startup, application startup and dev compilation are outside this measurement. No task-owned full build, regression suite or typecheck overlapped this final-source repeat. Other workstation/gateway activity is uncontrolled; this remains an exploratory shared-workstation pilot.

## Evidence and replay

Local evidence directory: `.cache/team-squad-live-2026-10-25/`.

| Artifact                         | Content                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `provider-preflight.json`        | Selected-model HTTP status, reply, elapsed time and returned usage.                                  |
| `final-campaign/manifest.json`   | Frozen cases, exact schedule, settings without credentials, source/input and measured bundle hashes. |
| `final-campaign/results.json`    | All 90 outputs, statuses, independent verdicts, timing/usage and aggregate metrics.                  |
| `final-campaign/attempts.ndjson` | Start and completion rows, written incrementally.                                                    |
| `final-campaign/calls.ndjson`    | 180 settled Squad call spans, including accounting identity and availability.                        |
| `final-source-manifest.json`     | SHA-256 for 6,236 bundle inputs and 2,490 output artifacts.                                          |
| `final-campaign.log`             | Redacted progress and final aggregate output.                                                        |

Measured checkout HEAD: `97b1659451ac678cbf05c543dfb8ce68da77d7dd`, with uncommitted task/concurrent changes. HEAD alone does not identify the measured source. The measured entry artifact SHA-256 is `807142e22ba34abb9ad156aab05cb99b05bfa01a5d4b6c1099e65d2c5ebab24d`; the complete bundle snapshot was built at 2026-10-25T00:48:13+08:00. The final bundle includes the completed input-validation, capability-refusal, UI and report-accounting hardening. All 73 owned source/test paths were hashed and rechecked unchanged during the repeat. The earlier `campaign/` and its source/bundle artifacts are retained as historical evidence; the table above uses only `final-campaign/`.

The checked-in runner is `scripts/smoke/team-eval-live.ts`; fixtures, seeded scheduling and deterministic oracles are in `lib/ai/eval/benchmark-protocol.ts`. To replay the saved final artifact:

```sh
COGNIA_TEAM_EVAL_SOURCE_MANIFEST=.cache/team-squad-live-2026-10-25/final-source-manifest.json \
COGNIA_TEAM_EVAL_DIR=.cache/team-squad-live-2026-10-25/replay-campaign \
rtk proxy node .cache/team-squad-live-2026-10-25/final-campaign-bundle/team-eval-live.mjs
```

To measure changed source, first build a fresh frozen bundle using the repository pipeline below. Set a new `BENCH_BUILD_DIR`; an existing bundle is refused. Then point the replay command at that directory's bundle and source manifest, with a fresh result directory.

```sh
BENCH_BUILD_DIR=.cache/team-eval-rebuild rtk proxy node --input-type=module <<'JS'
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { loadEsbuild, cliEsbuildOptions } from "./scripts/build/esbuild-shared.mjs"
const root = process.cwd()
const dir = process.env.BENCH_BUILD_DIR
if (!dir || fs.existsSync(dir)) throw new Error("Choose a fresh build directory")
const esbuild = await loadEsbuild()
const result = await esbuild.build({
  ...cliEsbuildOptions({
    root,
    entry: path.join(root, "scripts/smoke/team-eval-live.ts"),
    outdir: path.join(root, dir, "bundle"),
    entryNames: "team-eval-live",
  }),
  metafile: true,
})
const hashes = (items) => Object.keys(items)
  .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile())
  .map((p) => ({ path: p, sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex") }))
fs.writeFileSync(path.join(dir, "source-manifest.json"), JSON.stringify({
  builtAt: new Date().toISOString(),
  inputs: hashes(result.metafile.inputs),
  outputs: hashes(result.metafile.outputs),
}, null, 2) + "\n", { flag: "wx" })
JS
```

The runner reads the local proxy key through its CLI without printing or persisting it. An alternative endpoint/key/model can be supplied with `COGNIA_TEAM_EVAL_BASE_URL`, `COGNIA_TEAM_EVAL_API_KEY` and `COGNIA_TEAM_EVAL_MODEL`. Endpoints containing userinfo/query/fragment are refused. A run directory with an existing manifest is not overwritten.

## Interpretation limits

This pilot establishes a working real-model comparison and the observed orchestration overhead on small text tasks. Ten unique tasks are insufficient for a formal model-selection conclusion; repeated runs do not create thirty independent tasks. The empirical p95 is shown with its sample count and is not a stable population-tail estimate. Shared gateway load, model nondeterminism and workstation activity can change the timing.

Native tools, coding/file workspaces, remote agents, Twin/plugin memory, interactive approvals and adaptive/Ultracode profiles are not covered by this live profile. Unsupported configurations are explicitly blocked before spending model calls. The product displays the profile and its limits. Native workspace/shell acceptance requires its own isolated host and artifact-based tasks; no Tauri/device-performance claim is made here.

The complete repair ledger, regression results and remaining environment verification are tracked in [the evidence ledger](../evidence/2026-10-24-team-squad-evaluation-audit.md).

## Repair validation and outstanding environment checks

The final focused regression run passed **118 suites / 1,214 tests**. Root plus sidecar type checks, root ESLint, translation build/check/lint/sort, the eval-core package build and the static-export compatibility gate passed. Formatting and scoped diff checks passed. Tests cover failure with retained output, partial interruption accounting, simultaneous token/cost reservations, frozen input parity, persistent scheduling, trace acknowledgement and both current/legacy availability displays. No coverage run was requested.

The complete application build and served-browser journey have **not passed**. Chromium rendered the Lab, but the shared plugin-ready fixture timed out before the starter/preflight assertions. The subsequent E2E-enabled production build completed prebuild, then hit `ENOSPC: no space left on device` in webpack caching and was stopped (exit 143). Free sufficient disk space before completing the full build and rerunning `tests/e2e/eval/model-evaluation-lab.spec.ts`; the test assertions were not weakened. The repository-wide co-location gate also flags an unrelated concurrent Rust source, `crates/cognia-automation/src/cua_sandbox/lume/workspace.rs`; every owned runtime source has its required co-located regression.
