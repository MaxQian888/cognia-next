# Orchestration patterns

Pick the shape that matches the work. Each trades coordination cost for a different kind of leverage.

## Patterns

**Map–reduce (fan-out)** — split independent units, run concurrently, merge.
Use when: the task decomposes into pieces that don't need each other (audit N files, research M angles). The merge is the real work — don't just concatenate.

**Pipeline** — each item flows through stages independently; no barrier between stages.
Use when: items pass through the same sequence of steps and item B shouldn't wait for item A to finish stage 1. Wall-clock = slowest single chain, not sum-of-stages.

**Judge panel** — generate N independent attempts from different angles, score them, synthesize from the winner while grafting the best of the rest.
Use when: the solution space is wide and one-attempt-iterated would anchor too early.

**Adversarial verify** — for each candidate finding, spawn skeptics prompted to refute; keep it only if it survives a majority.
Use when: false positives are costly and a plausible-but-wrong answer would otherwise slip through.

**Loop-until-dry** — keep spawning finders until K consecutive rounds surface nothing new.
Use when: the result set is unknown-size (bugs, edge cases) and a fixed count would miss the tail.

## Decompose well
- Units must be independent — if B needs A's output, sequence them, don't race them.
- Each delegated brief is self-contained: goal, context (the agent doesn't share your memory), constraints, and the exact result shape.
- Fan out only what benefits from it; a quick lookup is cheaper inline.

## Stay within limits
Respect the depth, concurrency, tool, permission, and budget ceilings projected by
the host. Skill instructions never expand that envelope. Nested delegation
multiplies cost; stop fanning out as the budget runs low. A dead/skipped agent
returns nothing — filter and decide if the gap matters.

## Synthesis checklist
- Read every return; resolve contradictions (say which you trust and why).
- Drop redundancy; write the answer in one voice.
- Attribute load-bearing claims to their source.
- If the merged result doesn't answer the original task, re-dispatch the gap — don't ship a partial.
