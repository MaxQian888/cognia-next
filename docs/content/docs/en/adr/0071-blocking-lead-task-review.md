---
title: 0071 — Blocking Lead Task Review
description: An opt-in review node that puts the team lead between a task's work and its dependents, with deterministic diff evidence and a bounded revision loop.
---

## Status

Accepted. Implemented 2026-07-15. Opt-in (`taskReview.enabled`), default off.

## Context

An Agent Team could already produce work, but nothing could **stop** bad work
from being built on. The three mechanisms that existed all miss in the same way:

| Mechanism                                        | What it does                                                       | Why it doesn't block                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `prFeedback.reviewer` (PR feedback loop)         | Real reviewer role with an `approved`/`changes_requested` verdict.  | Runs **after** the DAG settles, observes and nudges. Also requires GitHub creds + a published PR; fail-closed off-desktop. |
| `governancePolicy.approval.requireResultReview`  | Routes a finished task to the board's `review` column.              | A **human** gate, and the wave runner's dependency progression ignores it — dependents consume the output regardless. |
| `pattern.*` ultracode nodes                      | Adversarial verify / judge panel / completeness critic.             | Gated on ultracode being active, and shaped as verification of a *finding*, not review of a teammate's diff.          |

So a team whose first task produced subtly wrong code would happily hand it to
three downstream tasks, and the operator would find out at the end.

The goal that forced the issue: an **Opus lead** that plans and reviews, and a
**Codex worker** that writes the code. The lead half of that had no
implementation.

## Decision

Add an internal workflow node kind, `action.team.task.review`, emitted by the
team synthesizer between each task's dispatch node and that task's dependents.

```
  taskA ──▶ review:taskA ──▶ taskB ──▶ review:taskB
```

**The gate is enforced by the scheduler, not by convention.** The synthesizer
repoints every dependent edge from `taskA` onto `review:taskA`, so an unapproved
task's dependents are simply not runnable. Nothing downstream has to remember to
check a flag — the DAG makes the wrong thing impossible rather than merely
detectable.

### Why a new node kind rather than reusing the PR reviewer

`pr-feedback/reviewer.ts` shares the vocabulary (`approved` /
`changes_requested`) and we deliberately mirror it, but it cannot be reused:

- it tells the model to go diff a GitHub PR **with its own tools**, whereas a
  reviewing lead has no tools at all;
- it presumes a published PR and resolvable GitHub credentials;
- it runs post-hoc, which is precisely the property we are fixing.

The two now coexist: PR review is about a branch that already exists in GitHub;
task review is about whether work may proceed inside the run.

### The lead reviews; it never edits

The lead is already excluded from dispatch (`workers = allMembers.filter(m =>
m.role === "teammate")`) — that exclusion is what makes it a credible reviewer,
and it is why review is the lead's job rather than a peer's. The reviewer call
therefore passes **no tools**, and its system prompt says so explicitly. A lead
that "just fixed it itself" would be landing unreviewed work outside the
worker's worktree.

### Evidence: the diff, not the claim

A reviewer shown only the worker's prose is reviewing a *claim*. An agent that
says "added validation and tests" while changing nothing reads identically to
one that did the work. So `review-evidence.ts` assembles what the task actually
changed, deterministically — no model, no tools, no network:

1. **The task's worktree branch** (preferred). Commit whatever the worker left
   uncommitted — workers are not required to commit — then diff
   `baseRef...agent/<runId>/<teammate>/<taskId>`. Diffing against the base (not
   the previous commit) means a revision round still sees the **cumulative**
   work, not just the delta since the last feedback.
2. **Uncommitted changes in the shared working dir**, when workspace isolation
   is off.
3. **Nothing** — then the deliverable text is the only evidence, and the prompt
   says so, telling the lead to treat an unbacked claim of code changes as
   grounds to request changes.

Capped at **64 KiB** of UTF-8, dropping whole files rather than splitting them:
a truncated patch reads as a complete one, so the omission is named in the
prompt instead. Git failures degrade to `kind: "text"` — never to approval.

### The revision loop

`changes_requested` re-dispatches **the same worker** into **the same worktree**
with the lead's feedback verbatim, then reviews again. Both halves are load-bearing:

- **Same worker** — the pool gained an exact-worker claim
  (`ClaimOptions.requireTeammateId`) that returns `null` rather than
  round-robining onto a substitute. Handing "please fix this" to someone who
  did not write the diff is meaningless, so an unavailable author is a failure,
  not a cue to substitute.
- **Same worktree** — the allocator already reuses a worktree by allocation key
  (`workspaceKey ?? taskId`), so passing the task id lands the revision on the
  branch under review.

Budget: `taskReview.maxRevisions`, default **2**, frozen into the node's params
at synthesis so a mid-run config edit cannot change a budget the DAG was already
shaped by. `0` is meaningful: review once, never revise.

### Everything unresolved fails the task and the run

Exhausted budget, an unavailable original worker, a reviewer/provider failure,
an unparseable verdict, or review enabled with no lead/reviewer wired — all mark
the task `failed` and throw non-retryably. The node is deliberately
`retryable: false`: retrying re-runs the worker into the same wall, and worse,
would let a flaky reviewer eventually rubber-stamp. **A gate that gives up and
approves is not a gate.**

### Composition with the human board gate

`requireResultReview` is orthogonal and composes: automated approval routes the
card to `review` (a human still has the last word) when it is set, and to
`completed` when it is not.

## Consequences

- **Cost.** One extra lead LLM turn per task, plus one worker turn per
  revision. This is why it is opt-in and off by default.
- **The lead is now on the critical path.** With review on, a lead that cannot
  resolve a provider fails every task. That is the same provider resolution
  planning uses — deliberately shared through `lead-execution.ts`, so a lead
  cannot plan on one provider and review on another.
- **Latency.** Reviews serialize behind their dispatch; independent tasks still
  review in parallel.
- **Not a security boundary.** The reviewer is a model. It raises the floor on
  quality; it does not make an untrusted worker safe. Workspace isolation and
  the sandbox remain the containment story.

## Alternatives considered

- **Review inside the dispatch executor.** Rejected: the blocking property would
  then live in a flag downstream nodes must honour, rather than in the graph.
- **One review node for the whole run.** Rejected: it cannot block anything —
  by the time it runs, every dependent has already consumed the bad output.
- **Reuse `dispatchStructured` for the reviewer.** Rejected: it claims a
  teammate from the pool, and the reviewer must be the lead, which is not in the
  pool.

## Where it lives

| Piece                       | File                                                    |
| --------------------------- | ------------------------------------------------------- |
| Policy resolution + node id | `lib/ai/agent/team/task-review-policy.ts`               |
| Prompt + verdict schema     | `lib/ai/agent/team/lead-review.ts`                      |
| Diff evidence               | `lib/ai/agent/team/review-evidence.ts`                  |
| Node emission + dep rewiring| `lib/ai/agent/team/synthesize-workflow.ts`              |
| Executor (the loop)         | `lib/workflow/nodes/built-ins.ts`                       |
| Reviewer wiring             | `lib/ai/agent/agent-team-runtime-deps.ts` (`runLeadReview`) |
| Exact-worker claim          | `lib/ai/agent/team/teammate-pool.ts`                    |
| Config                      | `types/agent/agent-team.ts` (`AgentTeamConfig.taskReview`) |
| Operator UI                 | `components/agent/workspace/settings/section-governance.tsx` |
