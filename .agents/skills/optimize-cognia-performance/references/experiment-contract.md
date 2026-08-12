# Performance Experiment Contract

Complete this contract before making a performance-motivated edit. Keep it in
the task notes, issue, or PR; do not create a repository document by default.

## Pre-registration

```text
User path:
Primary metric and unit:
Current target or performance budget:
Guardrail metrics and limits:
Platform / shell:
Device, OS, CPU, memory, and power mode:
Build mode and exact revision:
Workload, fixture, and data size:
External provider, model, region, and network controls:
Cold / warm state and reset procedure:
Warmup count:
Measured sample count:
Statistic to compare:
Noise rule:
Minimum practically important improvement:
Baseline command and expected side effects:
Correctness and shell-parity commands:
Raw evidence location:
Allowed source and filesystem mutations:
```

If no owner-approved target exists, define a task-local minimum practical
improvement before measuring the result. Do not convert it into repository
policy.

## Default local comparison

Use a tool-specific statistical benchmark when the codebase already provides
one. Otherwise use this default for a reasonably stable local duration:

1. Fix all conditions in the pre-registration.
2. Run at least one warmup unless cold start is the metric.
3. Collect at least ten baseline and ten result samples.
4. Compare medians and report median absolute deviation (MAD) for both groups.
5. Call the experiment a measured improvement only when the median delta is at
   least the predeclared practical threshold and greater than twice the larger
   MAD. Otherwise report it as inconclusive.

For cold-start work, restart from the same declared process and cache state for
every sample and report every observed value. For p95 or rarer tail claims, use
a sufficiently large real distribution or a dedicated load/benchmark tool;
label a small-sample percentile exploratory rather than authoritative.

This default is an experiment rule, not a confidence interval. For noisy,
high-cost, concurrent, or production workloads, choose and predeclare a more
appropriate method instead of weakening the rule after seeing the result.

## Decision ledger

```text
Hypothesis:
Change tested:
Baseline summary:
Result summary:
Delta:
Observed noise:
Guardrail results:
Correctness results:
Verdict: kept | removed | inconclusive | blocked
Reason:
Agent-owned instrumentation removed:
```

Record removed and inconclusive attempts in the task or PR evidence so another
agent does not repeat them. Never preserve a failed source change merely to
serve as its ledger.

## Chinese evidence report

```text
目标：<用户路径、平台、主指标和阈值>
环境：<设备、构建模式、数据、冷热状态、样本数>
基线：<统计量、离散度、原始证据位置>
改动：<单一假设和最小改动>
结果：<统计量、离散度、绝对值与百分比变化>
保护指标：<p95、内存、CPU、bundle、耗电或其他相关指标>
判定：<保留、移除、无结论或受阻，以及原因>
验证：<实际运行的正确性与多端命令>
未验证：<未覆盖的平台、设备或生产环境>
```
