# MultiAgentBench research: full 100-task round — 2026-10-25

Status: complete. All 100 tasks completed in all three modes, with 300 valid primary research grades. One infrastructure interruption makes 301 physical solver-trial attempts; one separately accounted judge-only recovery also completed. Earlier exploratory and corrective pilots are not pooled into these results.

## Protocol

- Dataset and rubric: pinned `ulab-uiuc/MARBLE` commit `8d60fa17b5596b44458a52d4296061b9fc13d6f2`; all 100 public research records validate before inference. Research SHA-256: `1c7583f1ee0583ac12a625fb5c19de7b5983344dde89a2254c1782d6309310e9`.
- One repetition, 100 tasks per candidate, 300 trials; seeded candidate order 20261025, outer concurrency one, maximum five parallel members. All original role profiles are retained, with public rosters from one to 22 members.
- The 100 source records are distinct introduction/profile configurations, containing 98 distinct introductions. Records 8/91 and 41/57 reuse an introduction with different researcher profiles; independence at the introduction level must not be assumed from the 100 record IDs.
- Solver and judge: `ark-deepseek-v4.1-flash`, endpoint `http://127.0.0.1:8787/v1`, temperature zero, requested reasoning effort `low`, no implicit SDK retries.
- Per-call output caps: solver 8192, judge 8192 tokens. Solver deadline: 1800000ms per trial. Independent judge deadline: 180000ms per call. Solver/judge admission budgets: 1000000/500000 tokens per trial.
- Profile `multiagentbench-research-text-v1`: closed-book research using supplied introductions and profiles; external literature and native tools are disabled. This is a Cognia adaptation, not an official full-MARBLE environment/leaderboard reproduction.
- Single Agent receives the union of public profiles. Serial and parallel Squads receive assigned profiles, contribute through the actual private Cognia launch/coordinator/DAG host, then synthesize a final five-question proposal.
- Innovation, safety and feasibility are source-rubric integer ratings from 1 to 5. Same-model judging is uncalibrated; scores are descriptive, not objective correctness or formal model selection. Communication and milestones are separate diagnostics.
- Completion means terminal completed execution with a nonempty proposal; it does not imply factual correctness. Primary-grade coverage is reported separately. All failed, cancelled, timed-out and ungraded attempts retain captured spend and elapsed time. Unknown measurements remain labeled as unknown/lower bounds.

## Frozen source and evidence

The campaign runtime was built at 2026-10-25T11:49:02.476+08:00 with Node v26.12.1, hashing 6239 source inputs and 2493 output artifacts. Exact hashes, selected tasks and the balanced schedule are retained in the manifests.

Evidence root: `.cache/multiagentbench-100-2026-10-25/`. The `plan/` directory validates all 100 records and all 300 scheduled identities without inference. `campaign/` retains the frozen runtime, `manifest.json`, `source-manifest.json`, incremental `attempts.ndjson`, `calls.ndjson`, `results.json` and upstream MIT license.

Before launch, the proxy returned HTTP 200 with 35 visible models, including the selected DeepSeek model. Behavioral RED/GREEN tests reproduce the earlier fixed 60-second judge cap and verify the new independent deadline. Focused regressions passed five suites / 60 tests; Node launcher tests passed 2/2; root plus sidecar typecheck and scoped ESLint passed. No coverage run was requested.

## Resource lifecycle

Each completed child admission removes waiters and releases its scheduler/concurrency lease in finally. The private Squad waits for workers and clears its run timer; its in-memory stores belong to that invocation. This closed-book host and the HTTP forwarding proxy do not allocate a VM or native workspace per task. Results and traces remain as evidence.

At the user's request, cleanup paths were checked with 68 passing coordinator/host regressions. An idle native esbuild service from the initial bundle build was identified and released at 2026-10-25T11:58:56.805+08:00, without stopping inference; a subsequent sample showed zero benchmark child processes. Future launches stop that service in finally before evaluation and after build failure, covered by five passing Node tests. These launcher-only edits are outside the running runtime's frozen input set; the inference bundle and campaign protocol remain unchanged. `build-worker-release.json` and `resource-samples.ndjson` retain the observed identities and process samples.

## Infrastructure interruption and recovery

After 133 complete cells, ENOSPC stopped the initial process in the case45 serial attempt. Disk free space was approximately 742MiB at failure and later recovered to approximately 11GiB. This task's artifacts totaled 155MiB; original evidence was preserved. The failed process and its lifetime-bound keepawake process exited.

Recovery verifies all 2493 original output hashes and imports the unchanged inference functions through an export-only copy of the original frozen entry. It retained all 133 completed cells and ran the remaining 167 in the original order, including one infrastructure recovery of the interrupted cell. No completed solver cell was retried for quality. Process/cache startup conditions naturally differ across the restart; the inference code and configuration remain identical.

The interrupted attempt retains four durable call spans totaling 14636 solver tokens and 52049ms of solver-call time. Unrecorded in-flight work remains unknown. Final accounting distinguishes 300 final cells from 301 physical attempts, and serial all-attempt resources are lower bounds. Quality means and completed-cell latency use their explicitly reported final-cell counts; all-attempt completion and spend include the interrupted attempt.

The continuation uses atomic snapshots, acknowledged-byte rollback of partial journal appends, a real 64MiB emergency reserve and a 1GiB pre-trial disk threshold. It waited for disk without model admission after cells 207, 223 and 294, and removed the reserve on exit. Ten zero-provider I/O/accounting probes passed, and independent wiring/accounting, PII and test reviews reconciled clear. Full code and receipts are under `recovery/`, `recovery-plan.json` and `continuation/` in the evidence root.

## Results

All candidates completed 100/100 unique tasks and received 100/100 valid primary grades. Completion means a terminal completed execution with a nonempty proposal, not objective research correctness.

| Mode           | Final completion | Primary grades | Mean rating / 5 | Innovation | Safety | Feasibility | Solver p50 / p95, s |
| -------------- | ---------------- | -------------- | --------------- | ---------- | ------ | ----------- | ------------------- |
| Single Agent   | 100/100          | 100/100        | 3.7933          | 3.89       | 4.26   | 3.23        | 34.871 / 46.371     |
| Serial Squad   | 100/100          | 100/100        | 3.4733          | 4.03       | 3.96   | 2.43        | 98.946 / 195.270    |
| Parallel Squad | 100/100          | 100/100        | 3.5300          | 3.99       | 4.04   | 2.56        | 54.945 / 81.580     |

The paired comparison covers the same 100 fully graded tasks. Serial scored higher/tied/lower than Single on 14/19/67 tasks, with mean difference -0.3200; Parallel scored higher/tied/lower on 13/31/56, with mean difference -0.2633. These are task counts, not correctness or hypothesis-test success rates.

Within this closed-book round, Single had the highest mean rating and the lowest observed solver time/token use. Both Squads had slightly higher innovation ratings, with lower safety and feasibility ratings. Parallel reduced solver p50 by 44.5% compared with Serial. This descriptive result does not establish that Squads are inferior on tool-based or coding tasks.

All-attempt completion is 100/100 for Single, 100/101 (99.01%) for Serial and 100/100 for Parallel; overall 300/301 (99.67%). The additional Serial attempt was interrupted by evidence-storage failure, not a model-quality retry. Its incomplete clock prevents an honest all-attempt Serial p50/p95, so the table explicitly uses the 100 completed final cells.

### Token consumption

| Mode           | Solver tokens, all attempts | Main judge tokens | Supplementary judge tokens | Combined tokens |
| -------------- | --------------------------- | ----------------- | -------------------------- | --------------- |
| Single Agent   | 635,213                     | 721,250           | 0                          | 1,356,463       |
| Serial Squad   | ≥2,941,484                  | ≥1,716,451        | 0                          | ≥4,657,935      |
| Parallel Squad | 2,689,739                   | 1,706,641         | 8,374                      | 4,404,754       |

The captured combined total is **at least 10,419,152 tokens**, including the interrupted attempt and supplementary judging. Each total is API-reported input plus output; cache-read counts remain separate metadata and are not added a second time. The 100 completed Serial cells alone used 2,926,848 solver tokens; the additional captured interruption contributes 14,636. Unrecorded solver or judge liability cannot be reconstructed and is not represented as measured zero. Currency cost remains unavailable because internal channel prices are unknown.

### Elapsed time and diagnostics

Solver wall totals for the 100 final cells were 3565.657 / 11164.072 / 5690.375 seconds for Single / Serial / Parallel. Including captured interrupted solver-call time makes Serial's all-attempt solver total at least 11216.121 seconds. Main judge-call time totaled 1663.210 / 2896.038 / 3088.370 seconds respectively; supplementary judging added 21.094 seconds to Parallel.

Observed per-trial envelopes, from trial start to last settled call and including judging, had p50/p95 of 51.068/65.156, 125.600/225.977 and 86.081/123.792 seconds. These exclude the intervening no-admission disk waits and restart gap. The whole main campaign ran from 2026-10-25T11:49:03.397+08:00 to 2026-10-25T20:27:43.454+08:00: **8h 38m 40.057s**, including a 23m 10.397s recovery gap and 25m 59.972s of observed disk-admission waits. Shared-host load and restart/cache conditions were not controlled; these are observed wall times, not isolated throughput limits.

All 300 research judgments parsed; all 196 applicable communication judgments parsed (100 Single and four one-researcher Squad cases are not applicable). Main milestone diagnostics graded 86/100 Single, 95/100 Serial and 94/100 Parallel, leaving 25 raw errors. One was output truncation and recovered separately below. The other 24 remain explicit diagnostic errors: 18 contain overlong descriptions, seven contain invalid agent IDs, with one case in both groups. No default score, relaxed assertion or quality-selected retry conceals them.

`comparison-final.json` reconciles solver/judge settlements against all-attempt aggregates and confirms all 300 schedule keys exactly once. `all-attempts.csv` retains 301 distinct solver-trial attempt IDs, including the interrupted initial attempt; supplementary judge evidence stays in its separate directory.

## Separately accounted judge-output recovery

The task78 parallel-Squad milestone diagnostic exhausted the fixed 8192-token ceiling with no visible JSON. Its research grade is valid. After all main cells settled, one supplementary call reused the original solver output and frozen rubric, changing only the output ceiling to 16384. It returned a valid milestone array, with the input digest matching the original and no degradation: 5896 input + 2478 output = **8374 tokens**, 21.094 seconds. Its temporary process, keepawake and reserve were released. Original failure/spend and all main scores remain unchanged; the supplementary view has 276/300 valid milestone diagnostics and 24 remaining errors.

An independent accounting review found and corrected premature completion at admission and missing-usage handling before any supplementary model call. Admission intent is now durable before dispatch, completion requires every judgment to settle, and failed/unknown usage remains a lower bound with actual attempt time. Ten zero-provider I/O/accounting probes pass, including failed admission preventing dispatch and partially allocated reserve cleanup. PII and wiring reviewers reconciled clear. This helper and its explicit results are retained in the evidence root; no solver quality retry is permitted.

## Final verification

- Node v26.12.1: repository Jest entry point passed **100 suites / 961 tests** in 21.194 seconds (`regression-node26-final.json/log`). Five launcher checks and ten I/O/accounting probes also passed (`node-final.log`, 15/15).
- Root and all configured sidecar typechecks passed (`typecheck-node26-final.log`, exit 0). Scoped ESLint for the changed launcher/runtime/runner and their tests passed (`lint-scoped-node26-final.log`, exit 0).
- Latest whole-repository `pnpm lint` exited 1 for an unrelated concurrent test warning: `lib/platform/host-feature-manifest.test.ts:902:17`, `'extra' is defined but only used as a type`. The warning remains visible; this report does not claim a green repository-wide lint gate. No unrelated file was edited to clear it.
- Final integrity verified all 2493 frozen outputs, exact export-only bridges, identical retained original 133 cells, and unchanged recovery harness. The active-credential artifact scan found zero matches; see `integrity-final.json` for its exact timestamp and file count.
- `resource-release-final.json` confirms main/recovery/keepawake/build process identities are gone and both emergency reserves and temporary snapshot files are absent. Benchmark and supplementary processes exited 0. No VM or native workspace was allocated by this profile; results and logs are retained.
- No coverage was requested or run. Full browser/native journeys, official tool-enabled MARBLE reproduction, coding tasks and judge calibration remain outside this acceptance boundary. No commit or push was performed.

## Reproduce

```sh
pnpm eval:multiagentbench --cases 100 --repetitions 1 \
  --model ark-deepseek-v4.1-flash --judge-model ark-deepseek-v4.1-flash \
  --reasoning-effort low --max-output-tokens 8192 --judge-max-output-tokens 8192 \
  --timeout-ms 1800000 --judge-timeout-ms 180000 \
  --token-budget 1000000 --judge-token-budget 500000
```

Use a fresh `--run-dir`; `--offline --source-dir .cache/multiagentbench-2026-10-25/upstream` reuses the hash-verified pinned cache. The actual campaign launches the same script with the Node 26 executable directly; this avoids the local pnpm shim's Node 24 runtime. See [the command guide](../development/multiagentbench.md) for credentials and artifact interpretation.

## Post-run problem analysis — 2026-10-25

This analysis made no new model calls and did not alter the campaign. `analysis/analyze.mjs` recomputes `analysis/derived.json` from the original results and verifies that the four inspected implementation files still match the actual frozen source. `analysis/selected-cases.json` retains complete evidence for cases 56, 92 and 99. Findings below separate measured symptoms, verified protocol choices and untested causal explanations.

### 1. Proposal feasibility is the main observed quality regression

| Mode     | Feasibility rating ≤2 | Contributions over 300 words | Mean final whitespace words | Solver calls for 100 final cells |
| -------- | --------------------- | ---------------------------- | --------------------------- | -------------------------------- |
| Single   | 10/100                | Not applicable               | 772                         | 100                              |
| Serial   | 60/100                | 97/511 (19.0%)               | 1048                        | 611                              |
| Parallel | 48/100                | 23/511 (4.5%)                | 1134                        | 611                              |

These are judge ratings, not independently established scientific feasibility. Both Squads gained a little innovation score while losing much more feasibility. Completed-cell solver tokens were 4.61×/4.23× Single for Serial/Parallel. More output and more calls did not buy a higher overall rating in this profile. Whitespace word counts are an approximate length diagnostic, never a substitute for API token accounting or a quality measure.

Case 56 makes the proposed failure mechanism visible. Single focuses on adaptive visual-token factorization and ImageNet evaluation (688 words; feasibility 4). Serial combines operads/category theory, PDHG, GNNs, image/video/audio, geographic synthesis, depth and perception tasks into one 1828-word proposal (feasibility 1). Parallel also uses the operadic framing (feasibility 2). Agent1's supplied profile is higher category theory, and the adapter always assigns final synthesis to that first profile. Source `multiagentbench.ts:238-262` gives every contributor a new research-direction task, requires dependency incorporation in Serial, and gives the final task a general integration instruction. It has no explicit candidate-elimination stage, feasibility review or scope acceptance gate. Source `team-execution.ts:375-385` fixes planning decisions rather than adding adaptive critique.

The supported hypothesis is **scope accumulation and persona anchoring**, particularly in the Serial chain. It remains a hypothesis about the average score gap: no lead-role swap, neutral-synthesis or critic ablation was run. Case 99 is a useful counterexample: Parallel narrows the idea to 3D hand-object graph refinement and scores 4/5/3, while Single spans several graph-learning application domains and scores 3/4/2. The aim should be stronger selection and coherent scope, rather than assuming every multi-Agent result is worse.

The post-hoc roster groups exhibit similar descriptive gaps but remain confounded by task topic. Among 16 tasks with at least 7 profiles, mean feasibility is 3.375 Single, 1.875 Serial and 2.3125 Parallel. This is not evidence for a universal 7-member cutoff. Length-limit violations are also observed model behavior: the 300-word requirement is currently only an instruction, not a validated contribution contract.

### 2. Communication ratings do not measure observed message exchange

Serial's mean communication rating is 4.439 and Parallel's 4.224 over 98 applicable tasks each. All 60 low-feasibility Serial tasks still receive communication ratings of at least 4. The current runtime supplies the judge a concatenation of final member outputs (`multiagentbench-runtime.ts:193-220`), with no sender/recipient edges, delivery/consumption events or dependency map. Parallel contributors do not read one another before synthesis, yet their outputs can still receive high communication scores.

These ratings describe the judge's impression of collected text. They do not prove useful interaction, correct coordination or information uptake. Preserve them as historical diagnostics; a future interaction metric needs actual dependency/message events and evidence of which delivered information affected subsequent decisions. The fixed chain/fork-join profile also leaves adaptive planning, iterative debate and native/tool collaboration unmeasured.

High communication and low feasibility scores can coexist legitimately: the criteria are different. That coexistence alone does not prove the communication judge is inaccurate. The limitation above follows from the actual evidence supplied to the judge.

### 3. Most remaining milestone failures are protocol compliance, not truncation

Only one of 25 raw milestone errors hit the output ceiling. Raising that call to 16384 recovered it; the other 24 have description-length or agent-ID violations. All seven invalid-ID cases are Single trials (30, 31, 42, 59, 67, 73, 95). Their judge outputs repeatedly use strings such as `single-agent, task final-proposal` as an identity, matching the ambiguity of the flat `Agent ... , task ...` header. This asymmetry makes raw milestone pass rates unsuitable for comparing collaboration quality.

The next adapter should give the judge a structured `agentId`/`taskId`/`output` transcript and an explicit allowed-ID list; apply enum/max-length constraints when the channel supports them, with local validation retained. Increasing every output ceiling does not address these 24 schema failures. Error messages should distinguish description length from unknown IDs so diagnosis does not depend on reparsing the full answer.

### 4. Crash recovery has not been incorporated into the permanent entry point

The successful disk guard, reserve, atomic snapshots, journal rollback and frozen resume were implemented in the retained one-off `recovery/resume.mjs`. The permanent `scripts/eval/multiagentbench-runner.ts:269-279` still writes `results.json` directly, and its CLI has no resume option. A subsequent ordinary full run therefore does not inherit the protections that allowed this campaign to finish. The actual interruption also shows why post-response spans alone cannot reconstruct every admitted call's spend.

Before another long campaign, bring these protections into the permanent runner with persistent tests, record durable per-call admission IDs before dispatch, and preserve admitted-but-unsettled liabilities on resume. Provider-reported usage or request records remain necessary to recover exact spend after a lost response; a durable intent cannot invent missing usage. This is an evidence-durability gap. This round did not establish a VM/workspace leak: its text profile allocates neither, task child resources were released, and process/reserve receipts are clear.

### 5. Optional evaluation consumes a substantial part of the measured budget

Of the captured 10,419,152 tokens, judging accounts for 4,152,716 (39.9%). Research scoring uses 1,119,827; optional communication/milestone diagnostics use 3,032,889 (29.1% of all captured tokens), across 497 calls including the supplementary call. These are shares of captured measurements; unknown interrupted liability still prevents exact all-attempt billing totals.

Solver cost and evaluation cost should remain separate when selecting a runtime. For future iterative experiments, run primary scoring on every task and reserve full optional diagnostics for a declared stratified subset or failed tasks. Record that sampling policy before execution, retain enough traces for offline inspection, and avoid interpreting lower diagnostic spend as an improvement in solver efficiency.

### 6. Completion and numeric grades need stronger acceptance evidence

The runtime's completion condition is terminal execution plus nonempty output. The primary rubric emits only three numbers; it provides no supporting rationale, claim verification or independent feasibility/novelty check. Both solver and judge are the same model with one observation per task. The closed-book profile also does not execute the literature retrieval and experiments required to validate scientific novelty. The 100 paired tasks support descriptive findings about this protocol, but not a general conclusion about Cognia Team quality or factual research correctness.

Before another full round, define separate execution, five-question structure, evidence grounding and calibrated quality criteria. A small blind review/repeated-judge set should measure judge agreement and sensitivity to answer length/format. Keep the current 300 primary grades unchanged.

### Recommended order

1. **Evidence integrity:** incorporate permanent atomic persistence/resume/admission accounting; clarify communication evidence and structured judge identities.
2. **Collaboration quality:** test neutral synthesis and explicit scope selection/feasibility review, using structured short contributions and explicit rejection reasons.
3. **Bounded validation:** preregister a small paired ablation with identical tasks/model/budgets, include an equal-compute Single revision control, and measure score components, solver tokens, latency and calibration separately. Profile/role changes create a new experiment version; do not pool them into this round.

No product implementation change or additional inference was performed as part of this analysis.

## Adversarial review — 2026-10-26

Two independent reviewers with fresh contexts examined statistical/causal claims and implementation/runtime claims respectively. Both reported no substantiated material finding after checking the artifacts. They received the artifact and evidence contract without the author's decision rationale. Cross-model review was explicitly offered under the project skill and skipped at the user's request. No benchmark inference or credential read was performed during this review.

The review retained the numeric comparisons and the verified permanent-runner recovery gap. Scope accumulation and first-profile anchoring remain untested causal hypotheses. Cases 56, 92 and 99 were chosen after observing outcomes and illustrate possible mechanisms; they do not estimate prevalence or establish the cause of the mean gap. Communication-score limitations follow from the flat transcript, rather than assuming that good communication must guarantee a feasible proposal.

A separate dataset audit added one actionable evidence-boundary clarification: the 100 task records contain 98 distinct introductions. The repeated-introduction pairs 8/91 and 41/57 use different researcher configurations, so the complete experimental inputs are distinct. Treating all records as independent research topics would overstate introduction-level diversity. All 100 original records, attempts and spending remain in the primary result.

As an offline sensitivity check, average each mode's scores within an introduction, then give each of the 98 introductions equal weight:

| Weighting                         | Single | Serial | Parallel |
| --------------------------------- | ------ | ------ | -------- |
| Original 100 records              | 3.7933 | 3.4733 | 3.5300   |
| Equal weight per 98 introductions | 3.7993 | 3.4762 | 3.5323   |

The observed ordering is unchanged. This sensitivity view is not a replacement primary score, an independent replication or proof of causality. Any future uncertainty interval should account for shared introductions and the selected task population.

Receipts: `adversarial-review/reconciliation.json`, `dataset-cluster-sensitivity.json` and the pre-review report snapshot. No new P0/P1 finding arose in this bounded review; the existing permanent recovery, judge-input and calibration work remains necessary before broader claims or another long campaign.

## Engineering follow-up — 2026-10-26

The follow-up repair extends the permanent CLI with a synced per-call journal, atomic snapshots, disk reserve/admission guard, exclusive writer lock and hash-verified frozen resume. Resume skips every durably settled cell, preserves interrupted attempts and known/unknown usage, and requires explicit `--retry-interrupted` before another attempt of an unsettled cell. Repeated failures while importing salvaged responses retain the remaining evidence. Owned lock/reserve cleanup is independent of model success.

New campaigns record evaluation protocol `structured-research-evidence-v2` separately from the unchanged solver graph. Judge input carries separate agent/task identities, explicit allowed IDs and bounded milestone schema; communication evidence contains observed dependency payloads and remains a text proxy. Each primary rating now requires a bounded reason and a verbatim proposal quote checked locally. Execution completion, five-question structure, contribution length and scientific grounding have separate fields. Primary-only judging is the new default; all/sampled diagnostics are declared in the manifest. Record/configuration/introduction counts and equal-introduction sensitivity summaries prevent topic counts from being overstated.

These changes do not modify any of the original 300 primary grades or raw campaign artifacts. Current source intentionally differs from the historical frozen source; the earlier source-equality checks above describe their dated execution. New judge output contracts and diagnostic policies must not be pooled into the old results. Scope accumulation/persona anchoring, causal quality improvements and scientific judge calibration remain unverified and need a separately declared experiment.

Repair evidence is retained under `.cache/multiagentbench-repairs-2026-10-26/`. See the updated [command guide](../development/multiagentbench.md) for recovery semantics and artifact interpretation.

One public task (ID1) was used for a bounded DS v4.1 Flash integration smoke with all diagnostics and a 16384-token judge cap:

| Mode     | Execution / structure / primary grade | Applicable judgments | Solver time | Solver tokens | Judge tokens |
| -------- | ------------------------------------- | -------------------- | ----------- | ------------- | ------------ |
| Single   | 1/1 each                              | 2/2 valid            | 42.17s      | 8086          | 9968         |
| Serial   | 1/1 each                              | 3/3 valid            | 92.90s      | 28701         | 27294        |
| Parallel | 1/1 each                              | 3/3 valid            | 48.16s      | 27215         | 22453        |

All 123717 captured tokens are measured; no currency rates are assumed. This single-task sample verifies protocol execution, not a quality improvement. A completed frozen resume returned exit0 with the same48 journal records and no new call event. The task's processes exited and lock/reserve/temporary snapshots were absent. The smoke froze the final solver/judge flow before subsequent recovery-rejection and launcher provenance refinements; those refinements have focused failure tests and a fresh final dry-run. The final launcher captures the actual compiler-loader bytes rather than hashing mutable sources after compilation.
