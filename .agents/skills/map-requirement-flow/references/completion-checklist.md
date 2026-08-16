# Requirement Flow completion checklist

Run every applicable gate. A flow is complete only when all Blocker gates pass. Mark non-applicable items deliberately;
do not omit them by accident.

## 1. Source and evidence integrity

- [ ] The complete source request and relevant linked artifacts were read.
- [ ] Repository behavior was inspected when the current product is in scope.
- [ ] Confirmed, Inferred, Assumed, and Open information are visibly separated.
- [ ] Every `Existing` capability cites current code, tests, configuration, docs, or observed behavior.
- [ ] Required future behavior is not described as current implementation.
- [ ] No route, API, event, tool, agent ability, service, metric, or owner was invented.
- [ ] Version-sensitive external facts were checked against current authoritative sources.

Failure of any applicable item above is a **Blocker**.

## 2. Requirement frame

- [ ] Primary actor, scenario, user state, trigger, entry point, goal, and terminal outcome are explicit.
- [ ] The underlying goal is an outcome rather than a proposed mechanism.
- [ ] Secondary, administrative, external-system, and system actors were considered.
- [ ] Scope and non-goals are explicit.
- [ ] Conflicting interpretations are resolved or recorded as Open decisions.

Missing actor, trigger, goal, or terminal outcome is a **Blocker**. Missing non-goals is usually **Major**.

## 3. Preconditions and dependencies

- [ ] Authentication, authorization, entitlement, consent, and role constraints were considered.
- [ ] Required prior state, data, configuration, feature flags, and installed capabilities were considered.
- [ ] Network, timing, platform, external-system, privacy, and compliance dependencies were considered.
- [ ] Every dependency is linked to the first flow step that needs it.
- [ ] Missing dependency behavior has an owner, recovery, or explicit Blocker.

An unstated prerequisite that makes entry impossible is a **Blocker**.

## 4. Happy Path integrity

- [ ] The path begins at a reachable entry and ends at an observable terminal state.
- [ ] Every step has a stable ID, actor, intent, action/event, response, state transition, feedback/signal, and next step.
- [ ] Independently failing actions are separate steps.
- [ ] Async work includes pending and completion states where behavior differs.
- [ ] Cross-page, cross-agent, cross-tool, cross-process, or cross-device handoffs preserve identity and context.
- [ ] No step is unreachable, duplicated, circular without purpose, or dead-ended.

An unreachable entry, missing terminal state, or dead end is a **Blocker**.

## 5. Branch and exception integrity

- [ ] Every branch references the originating Happy Path step.
- [ ] Alternative choices, early exit, and cancellation were considered.
- [ ] Missing, invalid, stale, duplicate, conflicting, and concurrent input were considered.
- [ ] Auth, permission, entitlement, offline, timeout, and dependency failures were considered.
- [ ] Partial success, retry, resume, fallback, compensation, and escalation were considered.
- [ ] Destructive operations include confirmation, idempotency, and recovery policy where applicable.
- [ ] Every branch ends in recovery, re-entry, fallback, escalation, or an explicit terminal outcome.

A branch with no outcome or recovery is a **Blocker**. A plausible but omitted edge case is generally **Major**.

## 6. Success and observability

- [ ] Every success criterion is observable and testable.
- [ ] Every Happy Path terminal outcome maps to at least one success criterion.
- [ ] Material error and recovery behavior maps to success criteria.
- [ ] Persistence, idempotency, permission, accessibility, performance, privacy, and platform criteria were considered.
- [ ] Numeric thresholds are sourced or marked Open, not invented.
- [ ] Every criterion names a verification seam: UI, public contract, state, telemetry, or test harness.
- [ ] Criteria use `Required`, `Proposed`, `Open`, or `Verified`; only current implementation evidence earns `Verified`.

A terminal outcome without observable evidence is a **Blocker**.

## 7. System ownership

- [ ] Page/UI, Agent, Tool/connector, Backend/native, Data/state, and Telemetry were considered per step.
- [ ] Every applicable capability is labeled `Existing`, `Change`, `New`, or `TBD`.
- [ ] `N/A` is used only with an evident reason.
- [ ] Cross-layer contracts have an owner and consumer.
- [ ] State source of truth and persistence owner are explicit.
- [ ] Required telemetry or audit evidence has an owning surface and event point.

A required capability with no owner is **Major**, or **Blocker** when no feasible path can execute the requirement.

## 8. Traceability and drift

- [ ] Every source requirement maps to Happy Path steps, branches, criteria, and owners.
- [ ] Every added flow step maps back to a source requirement, accepted inference, or explicit assumption.
- [ ] Partial and missing coverage remain visible.
- [ ] Delta updates identify all affected steps, branches, criteria, dependencies, and owners.
- [ ] Downstream artifacts can cite stable IDs without reinterpreting the flow.

Any source requirement with no mapped behavior is a **Blocker**.

## 9. Handoff discipline

- [ ] Open decisions identify options, a recommendation, consequence, and next owner/workflow.
- [ ] The readiness state is honest: reviewable, blocked, or ready for a named downstream workflow.
- [ ] Invoked downstream skills received IDs, evidence statuses, gaps, and decisions.
- [ ] No PRD, issue, proposal, prototype, test, implementation, Lark document, or whiteboard was created without scope.
- [ ] Decisions changed downstream were reconciled back into the Requirement Flow.

## Final verdict

Use exactly one verdict:

- **Complete for review**: All Blocker gates pass; Major/Minor findings and Open decisions are visible.
- **Ready for `<workflow>`**: All gates required by that downstream workflow pass.
- **Blocked**: Name the failed gates, missing authority/evidence, and the smallest next decision needed.

Do not use “complete” to mean “the Happy Path was written.”
