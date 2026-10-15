---
title: "0227 — Agent changes integrate through one host-side queue"
description: "An agent's work becomes a pinned changeset with review, checks and approval bound to its head commit; a host-owned integration transaction composes changesets in a reused integration worktree, verifies the exact candidate, and publishes it with a compare-and-swap ref update that can be rolled back."
---

# ADR 0227 — Agent changes integrate through one host-side queue

**Status:** Accepted  
**Date:** 2026-10-15  
**Amends:** ADR-0111 (closes its "host-side Agent Team merge-all promotion transaction" gap), ADR-0071 (review evidence diffs against the run base, so it is no longer commit-blind), ADR-0070 (adds path-based change risk)  
**Related:** ADR-0038, ADR-0150, ADR-0151, ADR-0176, ADR-0188 (acceptance profiles), ADR-0147

## Context

Anthropic's "Redesigning source control" post (2026-10-13) describes Scion, a
centralized, non-Git system built for tens of thousands of agent merges a day:
changesets as write-ahead-log entries, refs moved by single-row compare-and-swap,
history and blame served from derived indexes, on-demand object fetch through
tiered caches, and post-merge verification with automatic revert. Most of that
exists to survive a 100 GB history and 25 million CI checkouts a day. Cognia
runs a handful of agents on one machine against ordinary Git repositories, and
it must keep working with the user's own Git tooling. We adopt the ideas that
transfer and none of the infrastructure.

An audit of the tree on 2026-10-15 found that Cognia already has most of the
substrate:

- **Isolation** — the ADR-0111 Registry gives every chat turn, scheduled run and
  Agent Team dispatch a detached, locked, signed worktree sharing the source
  repository's object store; ADR-0176 puts every clone behind one bare-mirror
  cache with partial clone; sparse checkout and cache links come from
  `.cognia/workspace.json`.
- **Change capture** — the task-workspace ledger records each run's
  `ResourceChange` rows (agent, kind, hashes, insertions, sensitivity) and a
  reversible `PatchSet`.
- **Git operations** — `cognia-git` already offers diff, history, blame, commit,
  merge, rebase, cherry-pick, revert, worktree porcelain and batched
  `update-ref --stdin`; `lib/git/commands.ts` is the typed, transport-routed
  facade for local, paired and remote hosts.
- **Verification** — ADR-0188 acceptance profiles are approved at their command
  hash and run on an exact revision in the strongest available sandbox tier,
  with no network, producing a report the host collects rather than believes.
- **Review** — ADR-0071 lead review, `lib/git/ai-review.ts`, and the ADR-0070
  risk classifier.

What is missing is the thing that joins them. The audit's findings:

1. There is no record of an agent's change as a unit: base commit, head commit,
   files, review, checks and merge state are spread across five models, and the
   resolved base SHA is never stored.
2. `merge-all` is refused (`registry-controller.ts`, `action.team.reconcile`)
   because nothing host-side can integrate several worktrees atomically.
   `select` creates branches with no rollback when one of them fails.
3. No verification blocks anything. Test runs an agent chose to make are
   recorded as evidence and read by no gate.
4. Lead review is commit-blind: a teammate that commits its work leaves the
   reviewer an empty working-tree diff.
5. Risk is classified from tools and keywords only. A change to CI config, a
   migration or a credential file carries the same risk as a README edit, and
   sensitive paths are checked on read but not on apply.
6. Blame and history are recomputed on every call; maintenance keeps only the
   mirrors' commit-graphs fresh, not the source repositories agents work in.

## Decision

### 1. A changeset is a pinned commit plus a gate record

`cognia-task-workspace` gains `changeset.rs` and an `agent_changesets` table in
the existing SQLite store (additive migration; no Dexie change).

- **Capture** turns a Git-isolated workspace into an immutable commit without
  touching the user's branches or the worktree's index: a temporary index
  (`GIT_INDEX_FILE`) is seeded from the worktree HEAD, `add -A` stages the
  working state, `write-tree` and `commit-tree` produce the commit, and
  `refs/cognia/changesets/<id>` pins it against GC. Files classified sensitive
  by `resource.rs` are left out of the tree and listed as excluded — a
  credential never travels into an integration through a changeset.
- The record links task, conversation (session), run, agent, workspace,
  repository (Git common dir), target ref, **base SHA**, **head SHA**, per-file
  stats, declared dependencies, review, checks, approval, integration id and
  merged SHA.
- **Everything is bound to the head SHA.** A review, check result or approval
  recorded for one head is invalid for another. Re-capturing after a revision
  moves the head, resets the state to `draft` and so invalidates the gate.
- States: `draft → ready → approved | changes_requested → queued → integrating
  → merged | conflicted | failed`, `merged → rolled_back`, and `abandoned` from
  any non-terminal state. Illegal transitions are refused host-side.
- **Eligibility is computed host-side**: the review verdict is `approve` at the
  current head, every required check passed at the current head, and a human
  approval exists at the current head when the review says one is owed. The
  integration transaction refuses an ineligible changeset whatever the caller
  claims.

### 2. Integration is one host-side transaction per target ref

`integration.rs` and an `integration_runs` table own the queue.

- **Analyze** predicts conflicts before any checkout: pairwise and against the
  target tip with `git merge-tree --write-tree --name-only` (Git ≥ 2.38), plus
  file overlap. It orders changesets topologically by declared dependency, then
  by capture time. On an older Git the prediction degrades to overlap only and
  says so.
- **Prepare** resolves the target tip as the expected old SHA and composes the
  changesets in a **reused per-repository integration worktree** — detached,
  locked with a `cognia-integration:` reason the Registry reconcile recognises
  as owned, reset between runs with `checkout --detach --force` and `clean -fd`
  so ignored dependency directories survive. Strategy `merge` (`--no-ff`, one
  merge commit per changeset, trailers naming changeset and agent) or `rebase`
  (replay the changeset's commits linearly). `rerere` is enabled for the run, so
  a conflict Git has seen resolved before is resolved the same way and still
  verified. An unresolved conflict aborts that step; the policy either skips the
  changeset (marking it `conflicted` with its files) or stops the run.
  Integration-internal commits run with hooks disabled: verification is the
  explicit acceptance step, not whatever a hook happens to do.
- **Verify** runs the required acceptance profiles on the prepared candidate in
  the integration worktree through the existing ADR-0188 acceptance host. Checks
  are recorded against the candidate SHA.
- **Publish** moves the target ref with compare-and-swap:
  `update-ref <target> <candidate> <expected-old>`. If the target branch is
  checked out in a worktree, publish fast-forwards that worktree only when it is
  clean and its HEAD is the expected old SHA; a dirty checkout refuses with an
  actionable error rather than leaving the user's tree looking modified. A
  failed swap (the target moved) marks the run `stale`; the orchestrator
  rebuilds from the new tip, a bounded number of times.
- **Failure recovery.** When verification fails with more than one changeset,
  the orchestrator drops the most recently composed changeset, rebuilds and
  re-verifies, bounded by the queue size, so a single culprit is isolated and
  marked `failed` while the rest integrate. A run interrupted by a crash is
  recovered on open: a run caught mid-publish whose target already equals the
  candidate is recorded as published; anything else becomes `interrupted`, the
  integration worktree is reset, and its changesets return to `queued`.
- **Operation log and rollback.** Every ref transition is appended to the run's
  operation log. Rollback of a published run swaps the ref back with
  compare-and-swap while the target still points at the result; once the
  target has moved on it creates revert commits in the integration worktree,
  verifies nothing new, and publishes them with the same compare-and-swap.
  Rolled-back changesets become `rolled_back`.
- One run per (repository, target ref) at a time, enforced in-process and by
  the table.

### 3. Review is deterministic first, an agent second, a human when owed

- **Change risk** (`lib/scm/review/assess-change-risk.ts`) is a pure function
  over the changeset's files: protected paths (built-in defaults for CI
  workflows, deployment, migrations, lockfiles, ownership and Cognia config,
  plus `review.protectedPaths` declared in `.cognia/workspace.json`), sensitive
  exclusions, deletions, binary files and size. It returns the ADR-0070
  `RiskTier`, its reasons, and whether a human approval is owed (any protected
  path, any `high`).
- **Review agent** reuses `lib/git/ai-review.ts` per file, behind
  `hasNoLeakingPii`. A `critical` finding requests changes. When no model is
  available the review is recorded as unavailable and a human approval is owed —
  the gate never silently passes.
- **Checks** are the repository's approved acceptance profiles, named as
  required in `review.requiredChecks`. An unapproved or changed profile is
  refused, as ADR-0188 already does.
- **Human approval** is an explicit action bound to the head SHA.

### 4. One source-control port

`lib/scm/` exposes `SourceControlService` — snapshot, diff, history, blame,
commit, merge, rollback, changesets and integration — over the existing
`lib/git/commands.ts` and task-workspace client. Git is its only backend today;
a backend registry keyed by kind leaves room for another without a second
facade. Local and remote hosts are already a transport concern and stay one.

### 5. Agent Teams integrate through the queue

`merge-all` stops being refused: the Registry controller captures one changeset
per candidate (declaring task-graph dependencies), runs the review gate and
hands them to the integration queue. The target is the run's base branch when
the team opts in (`integration.target: "base"`); by default the result is
published to `agent/<run>/integrated`, so an unattended team never moves a
branch the user did not name. Lead review runs before the changeset exists, so
its evidence diffs the environment against the run's base (`baseRef`, else the
branch the source checkout is on): committed and uncommitted work both show,
which removes the commit blindness, and every rung passes the same sensitive-path
and PII gate as the review agent. `select` gains rollback of branches
it created when a later step fails.

### 6. Performance: shared objects, immutable caches, incremental indexes

- Blame and history results are cached in `cognia-git` keyed by the Git common
  dir, the resolved commit id, the path and the options. Keys are immutable, so
  nothing is invalidated; working-tree blame is never cached.
- Registry maintenance writes split commit-graphs with changed-path Bloom
  filters for every source repository that owns managed worktrees, which turns
  `log -- <path>`, merge-base and ancestry checks into lookups. No user Git
  config is written (the reason ADR-0176 avoids `git maintenance register`).
- Conflict prediction uses `merge-tree` and needs no checkout; the integration
  worktree is reused rather than created per run.
- Changeset refs for merged or abandoned changesets expire with the existing
  snapshot retention.

## Consequences

- An agent's work is one inspectable, reversible unit from capture to merge.
- `merge-all` works, and it is transactional: the target moves once, by
  compare-and-swap, to a candidate that was verified as composed.
- A check or approval cannot be replayed onto different code.
- Credentials cannot reach an integration through a changeset.
- The user's checkout is never left looking dirty by a ref moving underneath it.
- Rollback is a recorded operation, not an investigation.
- Not adopted: a virtual filesystem, a custom object protocol, server-side
  merge as a service, post-merge-only verification. The first measurement that
  shows linked worktrees and partial clone are not enough reopens this.

## Verification

- `cargo test -p cognia-task-workspace changeset integration` — capture with
  temp index (user index untouched), sensitive exclusion, head-bound gate
  invalidation, transition refusal, merge-tree prediction, rerere reuse,
  skip/stop conflict policies, CAS publish success and stale refusal,
  checked-out clean fast-forward and dirty refusal, crash recovery of each
  state, rollback by swap and by revert, concurrent runs on one target refused.
- `cargo test -p cognia-git query_cache` and maintenance tests.
- Co-located Jest suites for `lib/scm/**`, the risk assessor, the review agent,
  the orchestrator (stale retry, culprit isolation), the Agent Team controller
  (`merge-all`, `select` rollback) and the UI.
- A multi-agent concurrency test drives three captured changesets — two
  disjoint, one conflicting — through one queue and asserts the published ref,
  the conflict record and the rollback.
