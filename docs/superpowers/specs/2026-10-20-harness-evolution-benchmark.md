# Harness Evolution — benchmark

**Date:** 2026-10-20
**ADR:** [ADR-0237](../../content/docs/en/adr/0237-an-agents-harness-evolves-through-probed-approved-versions.md)
**Code:** `lib/harness/benchmark.ts`, `lib/harness/benchmark.test.ts`

## What it measures

The benchmark runs the real driver (`driveHarnessRun`) on the real Dexie store
(fake-indexeddb), with the real evidence builder, task checks, budget ledger, rollout reuse
and final selection. Only the model-facing steps are simulated:

- a rollout's outcome is a pure function of marker lines in the harness's always-on text
  (write the report, end with the total, refuse tools, be verbose, a neutral style line), with
  seeded flakiness (a tool error, nothing delivered);
- editors add the lines each scenario scripts per role and round or slot;
- the selector is scripted: one that prefers the longest answer with high confidence, one
  that abstains, one that answers with low confidence.

Every scenario knows the right answer, so the benchmark reports decision quality (accuracy,
false adoptions where the base was right, missed improvements where a change was right),
budget discipline (spend against `maxCostUsd`) and accounting (R = 4k rollouts and P = 3k editor
sessions on a run that reached its decision). It costs nothing and needs no provider. It does
not measure how good real editors are at finding improvements; that needs real models on real
tasks, as Harness² does.

## How to run

```bash
HARNESS_BENCHMARK=1 HARNESS_BENCHMARK_REPORT=/tmp/harness-bench.md node scripts/test/jest.mjs lib/harness/benchmark.test.ts --runInBand -t "full benchmark"
```

Without `HARNESS_BENCHMARK=1` the suite runs only the deterministic scenarios on one seed and
the report arithmetic, as an ordinary unit test.

## Results (seeds 1–5)

Seeds: 1, 2, 3, 4, 5 · runs: 40

- Decision accuracy: 98%
- False adoption rate (base was right): 5%
- Missed improvement rate (a change was right): 0%
- Runs over budget: 0
- Runs breaking R = 4k / P = 3k: 0

| Scenario | Accuracy | False adopt | Missed | Over budget | Mean cost | Rollouts (reused) | Editor sessions | Judge calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clear-improvement | 100% | 0 | 0 | 0 | $0.060 | 4.0 (2.0) | 3.0 | 0.0 |
| harmful-edit | 100% | 0 | 0 | 0 | $0.080 | 4.0 (1.0) | 3.0 | 0.0 |
| misleading-judge | 100% | 0 | 0 | 0 | $0.115 | 8.0 (4.0) | 6.0 | 0.0 |
| tie-uncertain-judge | 100% | 0 | 0 | 0 | $0.120 | 8.0 (4.0) | 6.0 | 1.0 |
| flaky-no-improvement | 80% | 1 | 0 | 0 | $0.120 | 8.0 (4.0) | 6.0 | 1.0 |
| sequential-two-fixes | 100% | 0 | 0 | 0 | $0.115 | 8.0 (4.0) | 6.0 | 0.0 |
| budget-stop | 100% | 0 | 0 | 0 | $0.240 | 2.0 (0.0) | 2.0 | 0.0 |
| outage-retry | 100% | 0 | 0 | 0 | $0.080 | 4.0 (2.0) | 3.0 | 0.0 |

- **clear-improvement**: The base writes nothing; the invariant editor finds both missing rules.
- **harmful-edit**: Every editor proposes a rule that stops tool use; the base was better.
- **misleading-judge**: One final passes every check, the other is only longer; the judge prefers length.
- **tie-uncertain-judge**: Candidates change nothing a check sees and the judge is unsure.
- **flaky-no-improvement**: A third of rollouts flake and the edits are neutral; any adoption is a false one.
- **sequential-two-fixes**: Each round finds one of two rules; only the second round has both.
- **budget-stop**: The budget affords the references and little else; the run must stop in time.
- **outage-retry**: A candidate's rollout times out once; the retry is the evidence.

## Reading the results

- **misleading-judge** reproduces the Harness² failure where the selector preferred a worse
  output. Here the final that passes every check dominates the base and is chosen without
  consulting the judge (0 judge calls), so the length-loving judge never gets the chance.
- **harmful-edit** and **tie-uncertain-judge** keep the base: regressions are excluded before
  any judgement, and a low-confidence verdict keeps the base when the base is a contender.
- **budget-stop** ends `budget_exceeded` at $0.24 against a $0.25 ceiling: the reservation of
  the worst observed step cost stops the run one step early rather than one step late.
- Rollout reuse halves the paid rollouts in the simple scenarios: a proposal that kept the base
  reuses the base rollout instead of paying again (the "reused" column).
- **flaky-no-improvement** shows the one false adoption (seed-dependent): a candidate runs once,
  and when both base replicates flaked while the candidate's single rollout did not, the
  candidate dominates the base's best run. Raising k gives the base more replicates and lowers
  the chance; re-running a dominant final before adoption would remove most of it (see the
  final summary's future improvements). Every adoption still needs a person's approval unless
  the change is low risk at task or session scope and auto-adoption is on.
