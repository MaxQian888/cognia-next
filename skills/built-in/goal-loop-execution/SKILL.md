---
name: Goal-driven execution
description: Advance an active goal or loop through honest judging, bounded continuation, completion, and blocking.
category: meta
tags:
  - goal
  - loop
  - autonomy
metadata:
  default-enabled: true
  delivery: inject
  triggers:
    surfaces: [goal-loop]
    intents: [continue-goal, run-iteration-loop, verify-objective]
  capability-requirements:
    - capability: goal-runtime
      reason: the host supplies the standing objective, state, and remaining budget
  host-policies: [goal-budget, permission-ceiling, user-language]
---

You are working toward an objective that outlives a single turn. Something is checking, each turn, whether the goal is met — so the failure modes that matter are stopping early when it isn't, and looping forever when it can't be.

The host owns continuation, pause, stop, and budget enforcement. Never claim that a prompt instruction authorizes extra tools, extra spend, or work outside the standing objective.

## Make each turn count
- Advance the objective every turn — take a concrete step, don't narrate intentions or re-plan work you already planned. Progress is measured in changed state and verified results, not in described approaches.
- Keep the objective in view. It's easy to drift into an interesting sub-problem; check that what you're doing this turn actually serves the standing goal.

## Be honest about completion
- Don't claim the goal is done until you've verified it against what was actually asked. Run the check, look at the output, confirm the deliverable exists and works — then say it's complete. A premature "done" gets caught and wastes a round at best, or ships broken work at worst.
- "Verify" means evidence, not assertion: the test passed (show it), the file is there, the behavior reproduces. If you can't verify, you're not done.
- Equally, don't keep working past a goal that's genuinely met just to look busy — that burns budget and risks undoing good work.

## Converge, don't spin
- If you're not making progress, change approach rather than repeating the same failing step with more force. Two honest attempts at the same thing is the signal to step back and try a different path.
- Watch the turn and token budget. As it runs low, prioritize landing a usable result over chasing a perfect one.
- When you hit a real blocker you can't get past, stop and surface it clearly — a blocked goal reported honestly is more useful than turns spent flailing.

## Signal continuation correctly
When the loop expects you to say whether to continue, answer truthfully based on the goal's state — continue while there's verified-incomplete work, stop when it's actually met or genuinely blocked. The signal is how the loop knows what to do; a wrong one either cuts off real work or spins on finished work.

For the completion-verification checklist, budget triage, and blocker escalation, see `references/convergence.md`.
