---
"cognia-next": minor
---

/goal: auto-raise acceptance + manual-continue for risky goals (ADR-0070 Phase 2)

At creation, a goal's redacted objective and its session's configured posture are
classified by the shared deterministic risk policy (`lib/policy/risk/`). Medium
risk auto-enables `requireAcceptance` (completion parks for human sign-off); high
risk additionally enables `manualContinue` — but only for an interactive origin,
since a headless goal that holds every turn would never advance. The assessment
is recorded on `goal_created` and shown in the goal's Activity tab.

Raise-only: a flag you set yourself is never cleared by the assessment.

**Intended behavior change:** a risky _headless_ goal (scheduler) now parks at
`awaitingAcceptance` instead of auto-completing. Set `GoalConfig.riskGating:
false` (or the `goals.riskGating` app default) to restore the previous behavior.

Also fixes `resolveGoalConfig` silently dropping a caller-supplied
`requireAcceptance` at goal creation.
