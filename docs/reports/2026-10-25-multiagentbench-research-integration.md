# MultiAgentBench research integration — 2026-10-25

The permanent `pnpm eval:multiagentbench` command now loads a fixed public research split and runs Cognia single-Agent, serial-Squad and parallel-Squad execution. This report distinguishes integration repairs from model quality and preserves every exploratory attempt.

## Scope and provenance

- Upstream: `ulab-uiuc/MARBLE`, commit `8d60fa17b5596b44458a52d4296061b9fc13d6f2`.
- All 100 public research records validate; actual rosters include one through 22 researchers. Full dataset/rubric/license SHA-256 checks precede selection or inference.
- Profile: `multiagentbench-research-text-v1`, a closed-book adaptation using supplied introductions and role profiles. External literature tools are disabled. This is not an official full-MARBLE environment/leaderboard reproduction.
- The single baseline receives all public profiles. Squads retain assigned roles, with sequential contributions or up to five parallel contributors, followed by synthesis. Execution uses Cognia's real model target and private launch/coordinator/DAG host.
- Main research ratings are innovation/safety/feasibility on the source 1–5 rubric. Communication and milestone scores are diagnostics. Strict parsing rejects invalid ratings rather than filling defaults. The judge is the same uncalibrated model; these observations do not select a formal winner.
- Solver and judge model: `ark-deepseek-v4.1-flash`; endpoint `http://127.0.0.1:8787/v1`. Requested reasoning effort is `low`, solver output cap 8192 and judge cap 2048, solver/judge admission budgets each 131072, deadline 180000ms, outer concurrency 1, seed 20261025 and one repetition per selected task.
- Wall time covers solver execution and orchestration; subsequent judge calls are accounted separately. API-reported tokens include reasoning when the endpoint reports it; gateway/internal retries and invoice reconciliation are outside the client trace.

## Three-task campaign and corrective diagnosis

The first low-reasoning campaign attempted tasks 1, 2, 3 in all three modes. It finished 9/9 trials, with 8 solver completions and 6 primary research grades. Task 2 exposed a privacy-routing bug: a loopback forwarder was treated as local even when the caller required cloud redaction. Its paper email was then blocked by the intact final PII gate. Squad members had an earlier redact pass and completed; their judges and the single baseline were blocked. Those missing grades measure the harness boundary, not research ability.

| Candidate      | Attempts | Solver completed | Primary graded | Conditional mean rating | Solver wall sum | Captured solver tokens | Captured judge tokens |
| -------------- | -------- | ---------------- | -------------- | ----------------------- | --------------- | ---------------------- | --------------------- |
| single-agent   | 3        | 2                | 2              | 3.167 / 5               | 98.597s         | 13,773                 | 14,417                |
| serial-squad   | 3        | 3                | 2              | 3.500 / 5               | 286.531s        | 72,381                 | 26,919                |
| parallel-squad | 3        | 3                | 2              | 3.500 / 5               | 157.814s        | 68,758                 | 30,995                |

Captured token totals retain partial/missing-measurement flags in the JSON. A pre-dispatch PII refusal has no settled model usage; the generic attempt ledger conservatively marks missing measurements. No neutral quality rating or measured-zero currency cost was substituted. Conditional score means above use only their explicitly reported graded counts and must not be interpreted as a complete three-task quality comparison.

A behavioral test using the real deep PII detector reproduced this refusal. Pure-model execution now honors the conservative `isLocal=false` requirement even on a loopback endpoint, redacts first, and retains the same final deep check. A scoped independent PII reconciliation confirmed no gate relaxation. Only task 2 is rerun after the correction; it is kept as a separate source-identified campaign.

## Corrective live acceptance

The final-source task 2 campaign completed all 3 solver trials and all 3 primary research grades, with exit code 0. Each row below is one public task and one repetition; the rows are not pooled with the earlier implementation snapshot.

| Candidate      | Completed / attempted | Innovation / safety / feasibility | Mean rating | Solver wall | Solver tokens | Judge tokens |
| -------------- | --------------------- | --------------------------------- | ----------- | ----------- | ------------- | ------------ |
| single-agent   | 1 / 1                 | 4 / 3 / 3                         | 3.333 / 5   | 37.887s     | 6,087         | 6,784        |
| serial-squad   | 1 / 1                 | 4 / 5 / 2                         | 3.667 / 5   | 129.826s    | 29,863        | 19,313       |
| parallel-squad | 1 / 1                 | 4 / 3 / 2                         | 3.000 / 5   | 63.505s     | 26,352        | 15,711       |

All solver and judge usage measurements are known in this corrective campaign. Cached reads are already part of the reported input total, not additional tokens. Judge totals include failed diagnostics. Both Squad communication ratings parsed as 4/5; their milestone judges each exhausted the 2048-output-token ceiling without a visible JSON response. Those two diagnostics remain ungraded errors with their measured input/output usage retained: serial 6290/2048 and parallel 4824/2048. The single-Agent milestone diagnostic parsed successfully; its communication rating is inapplicable. No parser fallback or automatic larger-budget retry was applied.

These observations establish the repaired integration path. One task with a same-model judge cannot establish a collaboration-quality winner, a representative success rate or stable tail latency. The rating differences and wall/token differences are descriptive only.

The final runtime snapshot was built at 2026-10-25T11:12:34.032+08:00 using Node v26.12.1, with 6239 source-input hashes and 2493 output hashes in `task2-verified/source-manifest.json`. The runtime entry SHA-256 is `1b0d84463afcfc578ec01df27c540b63d3a5daeed12f96aba43d412292009b16`. All 13 owned source/test/config paths stayed unchanged through execution. The final local artifact scan found zero matches for the active proxy credential across 12541 files (`integrity-verified.json`).

## Other repairs and validation

An earlier 2048-output-token smoke consumed the output cap without a visible answer. That failed single trial and a cancelled parallel trial remain in `live-research/`, including captured usage. Research budgets are now configurable, and private text members with empty visible outputs fail while retaining their settled usage. The explicit low reasoning setting is passed through the OpenAI-compatible SDK provider option for every candidate and judge.

Scoped reviewers also required source-valid roster sizes, explicit-endpoint credential binding, nested credential filtering, immediate handling of event-write rejection, and regressions for unknown judge usage and contribution survival after cancellation/timeout. All identified findings were repaired and reconciled.

Final functional checks after the privacy correction: 100 Jest suites / 960 tests passed in 21.744s; Node launcher tests 2/2; root plus sidecar typecheck, root ESLint, scoped formatting and the static-export gate passed. Production command bundles build successfully; the complete 100-task source dry-run passed. The repository-wide co-located-test audit still flags the unrelated concurrent `crates/cognia-automation/src/cua_sandbox/lume/workspace.rs`; all owned runtime modules have co-located tests. No coverage command was requested. This change adds a Node command and browser-compatible eval modules; no new UI route or full-application/browser acceptance claim is made.

## Artifacts and usage

Local artifact root: `.cache/multiagentbench-2026-10-25/`.

| Directory/file                      | Evidence                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `upstream/`                         | Exact pinned public research JSONL, evaluator rubrics, source evaluator and MIT license.   |
| `dry-run-verified/`                 | Complete 100-record validation, fixed source hashes and planned 9-trial schedule.          |
| `live-research/`                    | Preserved initial short-output-budget failed/cancelled attempts.                           |
| `live-research-final/`              | Complete pre-privacy-fix 9-trial campaign, outputs, grade refusals and all captured usage. |
| `task2-verified/`                   | Final-source corrective three-mode campaign on the affected public task.                   |
| `regression-release.json`           | Final 100-suite / 960-test result.                                                         |
| `owned-source-hashes-verified.json` | Owned source/test identity immediately before corrective execution.                        |

Each live directory retains `manifest.json`, `source-manifest.json`, `results.json`, incremental `attempts.ndjson`, `calls.ndjson` and `LICENSE.upstream`. Source/output hashes identify the actual bundled client code; a shared checkout HEAD alone is insufficient. Credentials are omitted from settings artifacts and filtered from nested provider errors and output serialization.

Run from the repository root:

```sh
pnpm eval:multiagentbench --dry-run --cases 3
pnpm eval:multiagentbench --cases 3 --repetitions 1
pnpm eval:multiagentbench --task-ids 2 --repetitions 1
```

Use a fresh `--run-dir` to preserve prior snapshots. [Developer guide](../development/multiagentbench.md) documents credentials, offline reuse, token controls, interpretation and the full artifact schema. Currency cost remains unavailable under the user's explicit token-first choice. Coding and external-tool environments remain later capability adapters.

Sources: [MultiAgentBench paper](https://arxiv.org/abs/2503.01935), [pinned source](https://github.com/ulab-uiuc/MARBLE/tree/8d60fa17b5596b44458a52d4296061b9fc13d6f2).
