---
title: "0173: The tracker has one programmatic face"
description: "Workflow nodes, the /issue command, ctx.issues and the External Bridge all reach the issue tracker through lib/issues/service.ts and the board's own gate, trail entries fan out on one in-process bus, and a work submission that names an issue is finally read."
---

# ADR 0173: The tracker has one programmatic face

**Status:** Accepted
**Date:** 2026-09-06
**Amends:** ADR-0132 (issue tracker), ADR-0045 (plan hub)
**Related:** ADR-0008 (external bridge), ADR-0123 (durable work submissions), ADR-0155 (plugin author boundary), ADR-0011 (visual workflows)

## Context

ADR-0132 built the tracker as a board. Every write went through
`IssueBulkAction` and `canApplyBulkAction`, so a person at the board was
refused the same moves for the same reasons wherever they clicked. Nothing
else could reach it. A workflow had fifteen `action.plan.*` nodes and no
`action.issue.*`. The composer had `/plan`, `/goal`, `/squad` and no
`/issue`. Plugins had `ctx.plans`, `ctx.goals`, `ctx.team` and no
`ctx.issues`. The External Bridge exposed memory, workflows and usage to an
outside agent and not one issue.

Two seams existed on paper and not in practice. `WorkSubmissionIntentV1`
has carried an optional `workItemRef` with `kind: "issue"` since ADR-0123,
and no code in the repository read it: a submission raised for an issue
validated and then forgot the issue. `PlanStep` had no way to say which issue
a step was doing the work for, so a plan that resolved an issue left no
trace on it.

The activity trail was append-only and read back through Dexie liveQuery.
That serves the detail panel. It gives a plugin, a workflow trigger or the
notification funnel nothing to subscribe to short of polling a table.

## Decision

### One service, one gate

`lib/issues/service.ts` is the tracker's programmatic face. It resolves an
issue by row id or printed identifier, creates into a container (named by id,
by key, or the workspace's first), applies one `IssueBulkAction` through
`applyIssueBulkAction` with the workspace's running set, and lists with the
same filters the board uses plus a text needle. Every caller below goes
through it, so a workflow, a slash command, a plugin and an MCP client are
refused a move on a running issue exactly as the board refuses it, and every
write lands in the trail with an actor that says who did it:
`workflow:<id>`, `plugin:<id>`, `mcp`, or the person.

### Four callers

- **Workflow nodes.** `action.issue.create / get / list / update / assign /
  comment / label` and the trigger `trigger.issue.event`, with parameter
  schemas, catalog entries and localized labels like every other built-in.
- **`/issue`.** `list`, `new` (with `#KEY`, `!priority`, `@me` pulled out of
  the title), `show`, `status`, `priority`, `assign`, `comment`, `chat` and
  `plan`.
- **`ctx.issues`.** A catalog namespace with `issue:read` and `issue:write`
  permissions, published at `@cognia/plugin-sdk/api/issues`. `onEvent` and
  `registerSyncProvider` return disposers and are marked so in the contract,
  which keeps them off the Python surface by the existing rule.
- **External Bridge.** `issues_list`, `issues_get`, `issues_create`,
  `issues_update`, `issues_comment` behind two new scopes, `issues:read` and
  `issues:write`, default OFF, mirrored in the Rust scope validator.

### One bus

`lib/issues/event-bus.ts` publishes every trail entry after
`appendIssueEvent` commits. The workflow trigger runner subscribes it, as does
`ctx.issues.onEvent`. A subscriber only ever sees rows that exist, and a
throwing subscriber is logged and never breaks the write path.

### The work item is read

`acceptWorkSubmission` keeps `workItemRef` on the submission row and, after
the commit, writes `work_started` to the issue's trail. `settleWorkSubmission`
writes `work_settled` with the outcome. Both are off the write path and
best-effort: a deleted issue is not a reason to refuse a turn. The producer is
`ChatSession.issueId`, set by `/issue chat`, which every turn of that session
forwards as its `workItemRef`.

`PlanStep.issueId` binds a step to an issue. `setStepStatus` writes
`work_settled` when such a step reaches a terminal status. `/issue plan`
drafts a one-step manual plan bound this way.

### Provenance both ways

An issue filed from a reply ("Save as issue" beside "Save as memory") or from
`/issue new` records `origin: { kind: "chat", sessionId, messageId? }`. The
detail panel and the mobile sheet render it as a link back to the
conversation through the existing message permalink.

## Consequences

- Refusals are uniform. A plugin cannot move an issue the board would not
  let a person move, and the trail shows which plugin tried.
- The trail gained `work_started` and `work_settled`. Older phones render
  them through the same tolerant projector as every other kind.
- The event bus is in-process. A phone or a headless host does not receive
  another device's trail entries through it. Cross-device delivery remains
  the companion sync pull, as before.
- `runtimes` for `ctx.issues` is `frontend` and `hybrid`. Opening it to Python
  is a one-line catalog change once the reverse RPC channel is audited for it.
- The bridge scopes are default OFF and gated in Settings like `memory:*`.

## Not done

- No `cycles` face for callers other than the board. A cycle is a container,
  and the phone and the bridge only read them.
- `WorkItemRef` kinds other than `issue` still have no reader.
