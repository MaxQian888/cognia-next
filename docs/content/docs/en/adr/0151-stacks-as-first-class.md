---
title: "0151 — Stacks as first-class"
description: "A stack of dependent pull requests already existed inside Agent Team: no write surface anywhere in the app, layers inferred from row timestamps and never checked against git, and a restack that merged rather than rebased. Extracts the engine, makes git the record, and connects it to the five callers that should have had it."
---

# ADR 0151 — Stacks as first-class

**Status:** Accepted
**Date:** 2026-08-26
**Related:** [ADR-0022](./0022-agent-team-runtime-hardening), [ADR-0038](./0038-source-control-panel), [ADR-0045](./0045-unified-plan-execution-hub), [ADR-0132](./0132-issue-tracker), [ADR-0150](./0150-repository-supply-and-object-cache)

## Context

A stack is a chain of branches where each is based on the one below it, opened
as a chain of pull requests so each review shows only its own change. One
already existed here — `delivery-graph.ts` had topological ordering, chained
base branches, cross-repository dependencies and bottom-up merge — and it was
unreachable and partly untrue:

- `githubDeliveryPolicy` had three readers and **no writer**. Nothing in the
  app could turn it on.
- Layers were inferred from `agentTeamChildRuns.createdAt` and **never checked
  against git**. A "stack" could be three unrelated branches, and publishing it
  produced pull requests whose diffs silently contained each other's work.
- Restacking used GitHub's `update-branch`, which **merges**. A merge does not
  move a layer onto its parent; it records that the parent happened. The stack
  survives on paper and its diffs stop being independent.
- `git_rebase` and `--force-with-lease` both existed and neither was on this
  path.
- Stack state was keyed by `runId`, so it ceased to exist when the run did.

Meanwhile GitHub shipped native stacked pull requests in public preview
(2026-07-30): a server-side stack object, cascading rebase, contiguous-range
merge, automatic retargeting after a merge, a stack-aware merge queue, and
branch protection evaluated against the stack base rather than the immediate
parent.

## Decision

**Git is the record.** A layer's parent lives in the repository's own config as
`branch.<name>.cognia-parent`. Not in a database beside it: the branches are
git's, a clone on another machine reads the same config, and a table that
disagrees with `git log` is worse than no table. Everything above treats its own
storage as a rebuildable projection.

**A parent pointer is a claim, and the claim is checked.**
`merge-base --is-ancestor` decides whether a layer actually contains its parent,
and a failed check refuses to publish and returns an executable remedy rather
than a boolean.

**Restack is `git replay --onto --contained`.** It computes new commits and
prints ref updates without touching any working tree, so a restack does not
disturb the worktrees this application cuts per task. `rebase --onto` in a
scratch worktree is the fallback where `replay` is absent, and the git binary's
capabilities are probed at runtime rather than inferred from a version.

**Not `rebase --update-refs`.** It refuses to update a branch checked out in
another worktree — which is precisely the case that matters here, and it skips
silently.

**Force-push carries `--force-with-lease` *and* `--force-if-includes`.** The
lease alone compares against the remote-tracking ref, which a background
`git fetch` has already updated; the second flag additionally requires the local
branch to contain what the tracking ref points at. It is probed, and its absence
is reported rather than hidden.

**Nothing is lost.** Every branch a restack moves has its previous tip written
to `refs/cognia/stack-history/<branch>/<millis>` first, so an unwanted restack
is one `update-ref` away from being undone and the old commits stay reachable.

**Local stacks are the truth; the forge's own stack is registered when
available.** Registering buys the forge's stack UI, its merge queue's stack
awareness, and branch protection evaluated against the stack base. When the
forge has no such object, the chain of base branches carries all of the shape
and none of the UI — which is what it did before.

**Fork-only access is refused, not degraded.** A pull request's base must exist
in the target repository, and every layer above the bottom is based on a branch
that lives only in the fork. GitHub's native stacks, ghstack, ejoffe/spr and
spacedentist/spr all decline this. Detecting it and saying so beats producing a
stack that cannot land.

## Callers

The engine is host-neutral (`lib/stack/`, `crates/cognia-git/src/stack.rs`) with
a forge adapter seam, and five callers use it:

- **Source Control** — a Stacks panel that lists, validates, restacks, records
  or clears parents, creates a new layer branch, publishes the chain of pull
  requests, lands it bottom first, and undoes a restack from the tip it pinned.
  The forge half is opt-in: nothing reaches GitHub until Publish or Land is
  pressed, and Restack force-pushes only once the stack has pull requests that
  would otherwise show commits which no longer exist.
- **Agent Team** — a settings switch for `githubDeliveryPolicy`, off by
  default, a trunk read that no longer reports whatever branch is checked out,
  and an ancestry check before anything is published.
- **Workflows** — built-in `action.stack.{list,parent,validate,restack,push}`.
  Forge delivery stays a plugin concern (ADR-0018/0026); putting GitHub
  credentials in the built-in node set to reach it would be the wrong trade.
- **Issues** — running a GitHub-linked issue can stack its pull request on
  another issue's branch, recording the parent in the local checkout so the
  chain is a stack in the panel and not three unrelated branches.
- **CLI** — `/stack` over direct `git` calls, writing the same config key, and
  `/pr` basing a pull request on the recorded parent.

## Consequences

**Two authoring models converge on one branch chain — one of them is inert.**
Branch-per-layer keeps its parent in git config and is what everything
produces. Commit-per-pull-request would identify a change by a
`Cognia-Change-Id` trailer written at commit time (no git hook installed); it is
declared, because the merge rule genuinely differs and writing that rule against
a model the type does not know is how it gets forgotten, but nothing authors it.
That dormancy is labelled on all three axes — the type, the panel, and a sweep
in `model.test.ts` that asserts its own scanned count before reporting no
callers.

**Agent Team's delivery graph is deliberately not `lib/stack`.** They look
alike and are not the same thing: a `Stack` is one repository's chain with git
as the truth and a restack as the repair, while the delivery graph is several
repositories with cross-repository dependencies, node state persisted so a
half-finished merge resumes, an approval gate, and a remediation loop that hands
a failing layer back to an agent. Folding it into `mergeStack` would drop all
four, so what is shared is shared — the ordering rule, the base chain, and the
ancestry check — and the rest stays.

**A chain of branches is not a stack until git says so.** Agent Team derived
its layers from `agentTeamChildRuns` sorted by `createdAt`, which reports who
finished first and nothing about ancestry: two agents branching off the trunk in
parallel produce exactly that list. `assertPublishableStack` writes each layer's
intended parent — which is also what makes a run's work visible in the Stacks
panel — then asks git, and refuses by name before any pull request exists.

**Merging is one sequence for all three methods.** After a layer merges, the
remainder is restacked onto the trunk — which drops the commits the merge
absorbed — then pushed, then retargeted, in that order. It is free when
unnecessary and correct when it is not.

**A node that returns a routing decision must declare its output handles.** The
workflow orchestrator skips every outgoing edge whose route key does not match
the decision, and a plainly-drawn edge has the route key `"default"`. A
deciding node without handles therefore skips everything downstream while the
graph looks correct. Both deciding stack nodes declare theirs, and a test pins
it.

## Alternatives considered

**A Dexie projection of stacks.** Planned, then rejected while implementing:
everything a stack is — which branches, in what order, on which trunk — falls
out of walking the parent pointers, and a pull request number must be re-read
from the forge each time because a cached one outlives the pull request being
closed. A table nothing reads is only a source of drift against
`git branch -d`, a rename, and a colleague's push.

**ghstack's synthetic bases** (`gh/<user>/<n>/{base,head}`). They cannot
register a native stack, and landing requires pushing directly to the default
branch, bypassing branch protection — an open complaint upstream since 2021.

**A merge queue of our own.** It needs a resident service, which this app's
static export cannot host (`app/api/` does not exist in production), and the
native queue is now stack-aware.

**Non-GitHub forges.** Only the adapter seam is built, with a second
implementation used in tests so the seam is proven pluggable rather than
asserted to be.

## What implementation overturned

- **`git replay`'s default flipped in git 2.54**, from printing ref updates to
  writing them, and `--contained` then moves branches nobody named. The
  wrapper passes `--ref-action=print` where supported *and* snapshots and
  restores `refs/heads` regardless, because the version that needs the guard is
  the one that will not accept the flag.
- **Both restack engines stamp a fresh committer date**, so restacking an
  already-aligned stack rewrites every layer to a new SHA. Ancestry is checked
  first and an aligned stack is left alone.
- **The rebase fallback must use the parent's tip from before anything moved.**
  Using the already-moved parent as the upstream replays its commits a second
  time.
- **A command absent from the companion manifest is permanently disabled in the
  UI**, even on the desktop where it is directly reachable — the descriptor is
  consulted before the "no client target means local host" branch. The existing
  audit only checked descriptor→handler, so a general guard was added in the
  other direction; it immediately found two pre-existing gaps.
