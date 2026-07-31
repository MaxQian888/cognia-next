---
"cognia-next": minor
---

Agent Team: auto-raise plan approval for risky runs (ADR-0070)

A new deterministic risk policy layer (`lib/policy/risk/`) classifies a team run
before it starts and raises the existing plan-approval gate when the roster can
drive the mouse, run native commands, destroy data, reach credentials, write
outside a sandbox, or send to an external recipient — even when
`requirePlanApproval` is off. Low-risk runs are untouched; no LLM is involved.

**Intended behavior change:** a _headless_ team run (scheduler / IM / bridge /
plugin / team→team) assessed medium or high risk now fails fast with a reason
naming the risk surfaces, instead of running unattended. Set
`AgentTeamConfig.riskGating: false` to restore the previous behavior per team.

Classification is origin-blind — being triggered from an IM conversation is not
itself treated as risk, so ordinary IM-bound team runs keep working.
