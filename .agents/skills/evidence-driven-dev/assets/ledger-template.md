# Evidence ledger: {{TITLE}}

- Status: exploring
- Lane: {{LANE}}
- Created: {{DATE}}
- Updated: {{DATE}}
- Related: <!-- spec / plan / ADR / issue / commit links -->

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> {{REQUEST}}

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement | State | Basis | Depends on |
| --- | --------- | ----- | ----- | ---------- |
| O1  |           |       |       | -          |
| H1  |           |       |       | O1         |
| G1  |           |       |       | -          |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it |
| ------------ | ------ | --------------------------- |
| scale        |        |                             |
| technical    |        |                             |
| coupling     |        |                             |
| requirement  |        |                             |
| verification |        |                             |
| risk         |        |                             |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact) | Severity | Source | Claim | Refuted by |
| --- | ------------- | -------- | ------ | ----- | ---------- |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk | Method | Independence | Evidence | Coverage | Status |
| --- | ---- | ------ | ------------ | -------- | -------- | ------ |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date | Decision | Action | Based on | Reversal trigger |
| --- | ---- | -------- | ------ | -------- | ---------------- |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual | From | Why still open | Next action | Status |
| --- | -------- | ---- | -------------- | ----------- | ------ |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal | How / when measured | Result | Status |
| --- | ------ | ------------------- | ------ | ------ |
