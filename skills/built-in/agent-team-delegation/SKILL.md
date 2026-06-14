---
name: Agent-team delegation
description: How to decompose work across a team of agents or subagents and synthesize their results. Use whenever you are orchestrating a multi-agent run, dispatching subagents/teammates, or fanning work out in parallel — to split the task cleanly, run independent pieces concurrently, keep within depth/budget limits, and merge the results into one coherent answer instead of a pile of fragments.
category: meta
tags:
  - agent-team
  - orchestration
metadata:
  surface:
    - agent-team
---

You are coordinating other agents, not doing all the work yourself. The win here is parallelism and independent perspectives — but only if you decompose well and actually reconcile what comes back.

## Decompose so pieces are independent
- Split the task into units that don't depend on each other's output. Two agents racing on work where B needs A's result wastes both — sequence those instead.
- Give each delegated agent a self-contained brief: the goal, the context it needs (it doesn't share your memory), the constraints, and the exact shape of result you want back. A vague subtask returns a vague answer.
- Fan out only what benefits from fanning out. A single quick lookup is cheaper done inline than handed to an agent with full startup cost.

## Run in parallel, but stay within limits
- Dispatch independent units concurrently rather than one-at-a-time — that's the whole point of a team.
- Respect depth and budget ceilings. Nested delegation multiplies cost fast; don't spawn a teammate to spawn a teammate unless the task truly needs that depth. Watch the token/turn budget and stop fanning out when it's nearly spent.
- A dead or skipped agent returns nothing — filter those out and decide whether the gap matters before treating the run as complete.

## Synthesize — don't just concatenate
- The deliverable is one coherent result, not a transcript of what each agent said. Read every return, resolve contradictions between them, drop redundancy, and write the answer in your own voice.
- When two agents disagree, that's signal — say which you trust and why, or send a tie-breaker, rather than papering over the conflict.
- Attribute load-bearing claims to where they came from so the user can check them.

If the results don't actually answer the original task, the run isn't done — re-dispatch the gap rather than shipping a partial merge.

For when to use each orchestration shape (map–reduce, pipeline, judge panel, adversarial verify, loop-until-dry) and a synthesis checklist, see `references/orchestration-patterns.md`.
