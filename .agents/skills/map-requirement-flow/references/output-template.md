# Requirement Flow output template

Use only sections that carry information, but never omit evidence status, the executable flow, abnormal paths, success
criteria, gaps, or traceability. Write concise cells. Use stable IDs so later PRDs, proposals, tests, and journey artifacts
can cite this flow without copying prose.

```markdown
# Requirement Flow: [Outcome-oriented name]

## 1. Requirement judgment

**Original request:** [Preserve the user's wording or a faithful summary]

**Underlying goal:** [Actor + desired outcome + value]

**Recommended interpretation:** [What this flow treats as the requirement and why]

**Scope:** [Included behavior]

**Non-goals:** [Explicit exclusions]

## 2. Evidence and decisions

| ID | Status | Item | Evidence or impact |
|---|---|---|---|
| E-01 | Confirmed / Inferred / Assumed / Open | ... | Source, code, test, document, or consequence |

## 3. Actors, scenarios, and triggers

| Actor | Scenario and state | Trigger / entry | Goal | Terminal outcome |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

## 4. Preconditions, dependencies, and constraints

| ID | Type | Requirement | Required by | Status / owner | Failure behavior |
|---|---|---|---|---|---|
| DEP-01 | Precondition / Runtime / Policy / Open | ... | HP-01 | Existing / New / TBD | ... |

## 5. Happy Path

| ID | Actor and intent | Action / event | System response | State / data transition | Feedback / signal | Next | Capability | Criteria |
|---|---|---|---|---|---|---|---|---|
| HP-01 | ... | ... | ... | ... | ... | HP-02 | Page: Existing; Backend: Change | SC-01 |

## 6. Branches and exceptions

| ID | From | Condition | Expected behavior | Recovery / re-entry / terminal outcome | Capability | Criteria |
|---|---|---|---|---|---|---|
| BR-HP02-01 | HP-02 | ... | ... | Resume at HP-02 | Tool: New | SC-04 |

## 7. System ownership map

| Flow IDs | Page / UI | Agent | Tool / connector | Backend / native | Data / state | Telemetry | Evidence status |
|---|---|---|---|---|---|---|---|
| HP-01, BR-HP01-01 | ... | ... | ... | ... | ... | ... | Existing / Change / New / TBD |

## 8. Success criteria

| ID | Observable criterion | Evidence or test seam | Covered flow IDs | Status |
|---|---|---|---|---|
| SC-01 | ... | UI / public contract / persisted state / telemetry | HP-01 | Required / Proposed / Open / Verified |

## 9. Journey gaps

| ID | Severity | Gap | Impact | Evidence status | Required decision or owner |
|---|---|---|---|---|---|
| GAP-01 | Blocker / Major / Minor | ... | ... | ... | ... |

## 10. Traceability matrix

| Source requirement | Happy Path | Branches | Success criteria | System owners | Coverage result |
|---|---|---|---|---|---|
| REQ-01 | HP-01–HP-03 | BR-HP02-01 | SC-01, SC-02 | Page, Backend | Covered / Partial / Missing |

## 11. Open decisions and handoff

| ID | Decision | Options | Recommendation | Consequence | Next workflow / owner |
|---|---|---|---|---|---|
| Q-01 | ... | A / B | A, because ... | Changes HP-03 and SC-04 | Product / prototype / technical proposal |

**Readiness:** Ready for review / Blocked / Ready for [named downstream workflow]
```

Use `Required` when the source explicitly requires the criterion, `Proposed` when analysis derives it, `Open` when a
decision or threshold is unresolved, and `Verified` only when current evidence proves the implemented behavior. Do not
use `Confirmed` here: reserve that term for evidence provenance so requirement intent cannot be confused with verified
implementation.

## Optional visuals

Add one Mermaid flowchart, swimlane, sequence diagram, or state diagram only when it makes three or more interacting
steps, actors, states, or components materially easier to understand. Keep the ID-based tables authoritative because they
carry evidence, ownership, branches, and traceability that a diagram usually cannot.

For Delta mode, add a compact impact table before the affected sections:

```markdown
| Change | Affected flow IDs | New / removed branches | Criteria impact | System impact |
|---|---|---|---|---|
| ... | HP-03, BR-HP03-02 | Added ... | SC-04 revised | Tool: Change |
```

For Audit mode, preserve valid source IDs. Add IDs only where missing, then return:

- confirmed strengths worth retaining;
- findings ordered by `Blocker`, `Major`, `Minor`;
- a corrected or patched flow for affected regions;
- residual Open decisions and the resulting readiness state.
