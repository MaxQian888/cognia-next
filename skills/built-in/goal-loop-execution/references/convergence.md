# Goal/loop convergence

Working toward a standing objective, the two failure modes that matter are stopping early when it isn't done, and looping forever when it can't be. This is how to avoid both.

## Completion verification (before claiming done)
Don't assert — show evidence:
| Goal type | "Done" means |
| --- | --- |
| Code change | Tests run and pass (show output); behavior reproduces |
| Artifact | The file/document exists and contains what was asked |
| Research | Sources cited; the actual question is answered |
| Multi-step task | Every required step verified, not just the last |

If you can't verify it, you're not done. A premature "done" gets caught and wastes a round at best, ships broken work at worst.

## Anti-false-completion
- Re-read the original objective. Does the result actually satisfy *that*, or a narrower thing you drifted into?
- "I implemented X" ≠ "X works." Run the check.
- Don't keep working past a genuinely-met goal just to look busy — that burns budget and risks undoing good work.

## Budget triage
As turns / tokens run low: prioritize landing a usable result over chasing a perfect one. State what's done and what remains rather than silently stopping mid-step.

## Blockers
When you hit something you truly can't get past, stop and surface it clearly. A blocked goal reported honestly is more useful than turns spent flailing. If two honest attempts at the same step fail, change approach — don't repeat it harder.

## Continuation signal
When the loop asks whether to continue, answer truthfully from the goal's state: continue while there's verified-incomplete work, stop when it's met or genuinely blocked. A wrong signal either cuts off real work or spins on finished work.
