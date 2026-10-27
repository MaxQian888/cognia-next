# MultiAgentBench research evaluation

Run the public MultiAgentBench research tasks through Cognia's production pure-model target and private Squad launch/coordinator/DAG host:

```sh
pnpm eval:multiagentbench --help
pnpm eval:multiagentbench --dry-run --cases 3
pnpm eval:multiagentbench --cases 3 --repetitions 1
```

The default endpoint is `http://127.0.0.1:8787/v1`, and both solver and judge default to `ark-deepseek-v4.1-flash`. Set `COGNIA_TEAM_EVAL_API_KEY` for an explicit credential. Solver and judge requests force cloud redaction even when the endpoint is a loopback forwarding proxy; the final deep PII check remains in place. Automatic local-proxy key discovery is restricted to that exact loopback endpoint. It checks the sibling `../aiden-llm-proxy/dist/cli.js`; `COGNIA_TEAM_EVAL_PROXY_CLI` can select another local installation. A custom `--base-url` requires an explicitly supplied key; credentials in URL userinfo/query/fragment are rejected.

The launcher releases its native build worker after bundling, including failed builds. Per-run Squad admissions return concurrency in finally and run timers are cleared; the closed-book host allocates no VM or native workspace. Evaluation outputs and accounting evidence are retained.

The command builds an immutable runtime snapshot in a fresh ignored `.cache/multiagentbench/<timestamp>/` directory. It downloads the public research split, rubrics and license at commit `8d60fa17b5596b44458a52d4296061b9fc13d6f2`, verifies every SHA-256 and validates all 100 tasks before selecting the first N. It refuses corrupt cache instead of replacing it silently. No Python environment or MARBLE model runner is required. `--task-ids 2,7` selects an explicit rerun subset after validating the complete split; it overrides `--cases` and rejects unknown or duplicate IDs. Use `--offline` after the source is cached, or `--source-dir` to reuse an existing pinned cache.

## Execution contract

The recorded profile is `multiagentbench-research-text-v1`: a **closed-book adaptation** using the public introductions and researcher profiles. External literature retrieval and native tools are disabled. It is not an official MARBLE environment/leaderboard reproduction. Coding, database, bargaining, Minecraft and Werewolf are outside this first research-track adapter.

- **Single Agent:** one model call receives the introduction, output requirements and union of all public researcher profiles.
- **Serial Squad:** each public researcher contributes in a fixed dependency chain, then a final task synthesizes all contributions.
- **Parallel Squad:** independent researcher contributions run with up to five concurrent members, then the same final synthesis task runs. All source roles are retained, including the public tasks with one or 22 researchers.

Role assignment is fixed; no live Squad definition, message store or completion workflow is modified. Every candidate runs every selected task/repetition in seeded randomized blocks, with experiment-level concurrency one. Solver and judge output default to an 8,192-token cap per call (`--max-output-tokens`, `--judge-max-output-tokens`). Judges have a separate per-call deadline of 60 seconds (`--judge-timeout-ms`); the solver deadline remains controlled by `--timeout-ms`. Reasoning effort is explicitly `low` by default (`--reasoning-effort low|medium|high`), identical for solver and judge calls. These controls use the OpenAI-compatible provider option. An empty visible answer is a failure even when reasoning consumed tokens; that usage is retained. `--token-budget` controls conservative solver admission per trial; `--judge-token-budget` controls a separate judge budget. Source tasks with more roles can consume more resources or exhaust an admission budget; those outcomes remain in the attempted denominator. Client SDK calls do not retry implicitly; proxy/provider-internal retries are outside this client trace.

## Scoring and accounting

The solver profile remains `multiagentbench-research-text-v1`. New campaigns separately record evaluation protocol `structured-research-evidence-v3` and artifact schema `cognia.multiagentbench-research/v3`; do not pool them with the historical numeric-only judgments. The source research criteria remain **innovation, safety and feasibility**, each an integer from 1 to 5. The v3 response contains `ratings` and `evidence`; each criterion needs a reason of 1–1500 characters and a verbatim proposal quote of 1–500 characters. Quotes are checked locally against the exact proposal text after the final outbound PII gate, including its redaction placeholders; that canonical text is retained as `visibleProposal`. These are inspectable subjective judgments, not independent scientific verification. The default same-model judge remains uncalibrated; results do not authorize formal model selection.

Execution completion, exact five-question heading/nonempty-section compliance, contribution length compliance, and subjective quality are separate fields. Contribution words use a declared whitespace count; exceeding 300 is recorded without truncating output, hiding usage or retrying. Grounding remains `not_independently_verified`. Dataset metadata distinguishes source records, complete configurations and unique introductions; summaries include an equal-introduction sensitivity mean alongside source-record weighting, with graded cluster counts.

Optional diagnostics default to **disabled** (`--diagnostics primary`). Select `--diagnostics all` or preregister `--diagnostics sampled --diagnostic-every 10` to select one in ten tasks within each public-role-count stratum (1–3, 4–6, 7+), with at least one per nonempty stratum. Selection is seeded, recorded before execution and shared across all variants/repetitions; a sparse stratum can therefore have a higher sampling fraction.

Communication and milestone diagnostics each receive only their own output schema. Source communication ratings are explicitly a **dependency-payload text proxy**. Evidence includes structured `agentId`, `taskId`, `output` records, exact allowed identities, and dependency payloads from member calls with returned samples. Payload inclusion does not prove information uptake or useful message exchange. Communication is inapplicable to the single-Agent baseline and one-researcher tasks. Milestone prompts include a JSON schema with exact identity enums and a 100-character description bound; local validation enforces those constraints and reports identity/length/schema errors separately. No provider-level structured-output capability is assumed. Malformed responses retain their usage and receive no fallback grade.

Solver and judge tokens are reported separately. Wall p50/p95 cover all solver attempts, excluding subsequent judging. Failed, cancelled, timed-out and ungraded work retains its captured usage and wall time. Unknown or partial measurements are labeled explicitly, and totals are marked as lower bounds. Unknown judge usage prevents further judge-call admission. Currency cost remains unavailable until channel-specific prices are supplied. Communication text length is not used as a substitute for API token usage.

## Artifacts and replay

The Node-only `scripts/eval/multiagentbench-validation.ts` owns frozen-input schemas and projection consistency. It keeps externally recovered data validation separate from the existing runner’s I/O/execution flow, while reusing the same research parsers and structure rules. Both fresh execution and frozen resume call it.

| File                   | Content                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`        | Exact selected source tasks, profiles, schedule, source pins, model/endpoint, profile and budgets; no credential.                |
| `source-manifest.json` | SHA-256 of actual esbuild loader contents (including plugin/virtual outputs) and runtime artifacts, Node version and build time. |
| `results.json`         | Atomic projection; primary-cell summaries, all-attempt call accounting, interrupted liabilities and response salvage.            |
| `events.ndjson`        | Authoritative synced journal: unique trial attempts and awaited per-call admission/settlement, including synthesis.              |
| `LICENSE.upstream`     | The upstream MIT license.                                                                                                        |

Current credentials are filtered from serialized outputs, nested provider errors and console summaries. Evidence-write failure aborts the invocation internally, rejects already waiting admissions, retains returned samples before settlement persistence, and attempts an atomic salvage snapshot. One exclusive process lock protects each run. The disk guard waits below 1 GiB free plus its 64 MiB reserve; waits are abortable. On ENOSPC it releases only that reserve, rolls an append back to its acknowledged byte boundary and retries once. Snapshots use sync plus atomic rename, and journal writes sync both file and parent directory. Close is terminal and idempotent, waits for queued work, aborts disk waits, checks its exact owner nonce, releases owned locks/reserves and retains cleanup errors. Retained closed instances cannot append or delete a successor’s reserve. No unrelated caches or evidence are deleted.

Fresh runs refuse existing directories. Resume without rebuilding:

```sh
pnpm eval:multiagentbench --resume .cache/multiagentbench/MY_RUN
# Only when another attempt of an unsettled cell is intended:
pnpm eval:multiagentbench --resume .cache/multiagentbench/MY_RUN --retry-interrupted
```

Resume verifies every recorded frozen output hash and the entry point before importing it or reading credentials; it rejects all protocol/source overrides. Frozen execution options are validated independently against CLI types/bounds and every derived manifest field before opening recovery storage or reading credentials. Complete candidate events, samples, nonnegative finite metrics and trial projections are validated before any journal import or torn-tail repair. Settlement phase, agent ID, task ID and judgment kind must match admission. Interior UTF-8 is decoded strictly; acknowledged prefix bytes are preserved unchanged. It replays synced settlements even when `results.json` lags, preserves failed/cancelled/ungraded settled cells, and skips them without quality retries. Unsettled attempts require the explicit retry flag and keep their original IDs, captured samples and unknown-call liabilities. Missing responses cannot be assigned invented token counts. Incomplete trailing bytes are retained in `journal-tail-*.bin` before rollback; corrupt interior records stop recovery. Previous snapshots are kept as `snapshot-before-resume-*.json`; salvaged settled events survive repeated recovery I/O failures and are imported once. A fully settled resume makes no credential lookup or model call. Pre-v3 snapshots must retain their original frozen runner and documented recovery procedure; the current launcher refuses them without migration or mutation.

Choose a fresh `--run-dir` for each repeat. Use identical task count, repetitions, seed, models and budgets to repeat a protocol. Increase to `--cases 100` only after validating the small run and its resource requirements. A completed small run is an integration acceptance test; repeated observations of three tasks do not establish general collaboration quality.

Exit code 0 means all planned solver trials completed and their primary research ratings parsed. It does not select a winner. Execution/configuration failures or missing primary grades return a nonzero exit code while retaining available evidence.

Sources: [MultiAgentBench paper](https://arxiv.org/abs/2503.01935), [pinned research dataset](https://github.com/ulab-uiuc/MARBLE/blob/8d60fa17b5596b44458a52d4296061b9fc13d6f2/multiagentbench/research/research_main.jsonl), [pinned evaluator rubrics](https://github.com/ulab-uiuc/MARBLE/blob/8d60fa17b5596b44458a52d4296061b9fc13d6f2/marble/evaluator/evaluator_prompts.json).

A complete research round with the larger diagnostic budget used on 2026-10-25:

```sh
pnpm eval:multiagentbench --cases 100 --repetitions 1 \
  --model ark-deepseek-v4.1-flash --judge-model ark-deepseek-v4.1-flash \
  --reasoning-effort low --max-output-tokens 8192 --judge-max-output-tokens 8192 \
  --timeout-ms 1800000 --judge-timeout-ms 180000 \
  --token-budget 1000000 --judge-token-budget 500000
```

The historical round used all diagnostics; pass `--diagnostics all` to select them in a new v3 run. This does not reproduce its old judge protocol. Large-roster tasks require more member calls. The output cap is a ceiling, not a requested output length or a guarantee against truncation; failed diagnostics remain visible with captured usage. The launcher accepts judge ceilings through 16384 tokens. For a new round, `--judge-max-output-tokens 16384` provides more headroom; it does not change the recorded 8192-token protocol above.

Any post-round recovery of a truncated judgment must reuse the original solver output, rubric and judge input, retain the failed judgment, and account for supplementary judge tokens separately. It must not rerun the solver or select the better score. The full-round report records any such recovery separately from the unchanged main results.
