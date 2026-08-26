---
title: "0150 — Repository supply and the object cache"
description: "Getting a task a working copy was measured rather than guessed, and the answer was not the clone. The per-task snapshot read and hashed the whole tree that git already held; the clone paths that did pay a network cost paid it again every time. Records what was measured, what changed, and the four supply premises the measurements overturned."
---

# ADR 0150 — Repository supply and the object cache

**Status:** Accepted
**Date:** 2026-08-26
**Related:** [ADR-0111](./0111-managed-workspace-registry-and-bundle), [ADR-0144](./0144-workspace-as-the-unit-of-work), [ADR-0147](./0147-repository-declared-workspace), [ADR-0151](./0151-stacks-as-first-class)

## Context

Two complaints about getting a task a working copy arrived together: it is
slow, and repositories are cloned over and over. Neither said where the time
went, and the obvious answer — the clone — turned out to be wrong for the path
that mattered most.

Nothing on these paths was instrumented, so the first change was to add spans
and record a baseline against this repository (280.2 MB, 25,138 tracked files):

| Per-task cost | Measured |
| --- | --- |
| `git worktree add --detach` (full checkout) | **3.1 s** |
| Reading and hashing every tracked file (`capture_with_policy`'s floor) | **5.5 s** |

The snapshot's real cost was higher than its floor: it held all 280 MB of blobs
in one `HashMap<String, Vec<u8>>` at once, then compressed and wrote each into
SQLite — for content git already had, on a path whose isolation mechanism is a
git worktree.

## Decision

**Measure before optimising, and publish the numbers.** Every supply path
carries a `cognia_instrument` span, and each batch below re-recorded the
baseline. Without that, the work would have gone into the clone, which is where
it looked like it should go.

**The snapshot stores only what git does not have.** Under git isolation the
committed content is referenced by commit SHA and only the dirty and untracked
delta is captured. 13.67 s → 0.546 s, 287.8 MB → 13.8 MB on the baseline
repository. `transfer.rs` / `bundle.rs` / `ledger.rs` were changed with it, or
ADR-0111's rollback and transfer would have been reading a snapshot shape that
no longer existed.

**One bare mirror per remote, keyed on the normalised URL.**
`https://host/o/r`, `.../r.git` and `git@host:o/r.git` are one repository and
therefore one mirror; keying on the raw string cached the same repository up to
four times and fetched each separately. Credentials are stripped before the key
is computed — it becomes a directory name on disk.

**Partial, never shallow.** `--filter=blob:none` everywhere the app clones on a
user's behalf. `--depth` truncates history, and a truncated history cannot be
rebased past its boundary, cannot answer `merge-base`, and shows one commit to
`git log` — while the same checkouts are handed to callers that ask for exactly
those. GitHub's own published measurements also put a shallow *fetch* well
behind a full one, and every later fetch in the workspace inherits that cost.

**A cache miss is never an error.** A corrupt mirror, an unfetchable remote, a
branch created upstream since the last fetch: each falls through to the plain
network clone, leaving no half-written directory behind. A cache must cost a
slow clone, never a broken run.

**Dependency provisioning is inferred and then confirmed.** Lockfiles imply the
supply strategy (pnpm's global virtual store for JS, link-farmed caches for
`target` and `.venv`), presented as a local Workspace setting the user accepts.
It is not written into the repository declaration: that would put a machine's
convenience inside ADR-0147's trust gate, which is about what a repository is
allowed to assert.

## Consequences

**A clone is not the unit of cost.** The per-task path never cloned; the
mirror's beneficiaries are the paths that did — the issue loop, plugin
workspaces, sandboxes — where the second acquisition of a repository is now
local.

**Blobless clones defer a cost rather than removing it.** A command that needs
historical file contents (`git log -p`, `blame` over old revisions) fetches
them on demand, one round trip per missing object under protocol v0. This is
why repositories the user clones themselves through Source Control stay
complete: they typed the URL, and they are the ones who run `blame`.

**pnpm's own warning stands.** "Do not use one writable pnpm store for mutually
untrusted agents or users." The global virtual store is offered for a single
user's own workspaces, not as a shared build cache.

## Alternatives considered

**`--reference` / alternates.** Cheaper than a mirror and rejected: git's
documentation states plainly that gc in the reference repository can leave the
clone corrupt, and a mirror refreshed on a schedule is exactly the repository
that gets gc'd. Cloning from the mirror copies what is needed, and afterwards
the two are independent.

**Hardlinked local clones.** `git clone` from a local path shares pack inodes
by default, which is faster still. Several of these clones are handed to an
agent with shell access on a path whose instructions come from an issue body
anyone can file; one write into a shared pack file would corrupt the cache for
every other user of that repository. `--no-hardlinks` is the price of not
sharing a mutable inode with an untrusted process.

**`git maintenance register`.** It writes the repository into the user's
*global* config and schedules machine-wide background jobs against it. These
are our cache directories, not the user's repositories. The commit-graph and
multi-pack-index are written directly instead — the same benefit for the
ancestry walks [ADR-0151](./0151-stacks-as-first-class) runs on every stack
validation, with no global state.

**A pre-flight size probe for guarded clones.** It would need to ask each forge
how big a repository is, which is a per-host API call that `cognia-git`
deliberately cannot make: the crate is built with no network transport at all.
The blobless default keeps the usual case small and the post-clone size check
remains the backstop.

**Removing the second clone in `commit_and_push`.** It looks like waste and is
a trust boundary: `mirror_worktree` copies the agent's files but never its
`.git`, so the commit and push run against a repository the agent could not
have written to. Committing in the agent's own workspace would run whatever it
left in `.git/hooks` while our token is in the environment.

## What the measurements overturned

- **The clone was not the cost.** `create_execution` runs `git worktree add`
  directly against the user's repository; there was never a clone on that path.
- **The snapshot was.** It was reading and hashing content git already held, at
  peak memory equal to the whole tree.
- **`--depth 1` was not a saving.** It was an amputation on a checkout whose
  callers ask for history, and by GitHub's measurements not even faster.
- **A per-remote mutex was worth more than parallelising bundles.** With a
  lock on the repository's common dir, same-repository work already serialises;
  multi-repository bundles are rare enough that parallelising them was more
  risk than benefit.
