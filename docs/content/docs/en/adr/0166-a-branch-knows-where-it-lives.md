---
title: "0166 - A branch knows where it lives"
description: "Branches and worktrees were never joined in the data layer, so the picker offered checkouts against worktrees the app had cut itself. The join lands in Rust, the three structural surfaces move out of an overflow menu into one navigator, and the panel measures its own pane instead of the window."
---

# ADR 0166 - A branch knows where it lives

**Status:** Accepted
**Date:** 2026-09-03
**Related:** [ADR-0038](./0038-source-control-panel), [ADR-0111](./0111-managed-workspace-registry-and-bundle), [ADR-0129](./0129-unified-global-search), [ADR-0144](./0144-workspace-as-the-unit-of-work), [ADR-0151](./0151-stacks-as-first-class)

## Context

Source Control read as three separate features that happened to share a route.
The complaint was that branches and worktrees felt disconnected, that the panel
had logic holes, and that it had no answer for a narrow screen. All three
turned out to have one origin.

**Branches and worktrees were never joined.** `GitBranch` carried
`{name, isCurrent, isRemote, upstream, ahead, behind}` and nothing about where
the branch was checked out. `GitWorktree` knew its own branch, but the store
held only branches, stashes and conflicts, and `lib/git/load.ts` never called
`gitWorktreeList` at all. With no join available, every branch row rendered the
same checkout button and let git decide.

Git decides by refusing: a branch a second worktree already holds cannot be
checked out. And this application cuts those worktrees itself, for isolated
runs, on branches named `agent/<run>/<teammate>/<task>` (ADR-0111). The panel
was therefore offering an operation it could have known would fail, against
worktrees of its own making. The same missing join made `checkout origin/x`
detach HEAD instead of creating a tracking branch, made delete offered where
git would refuse it, and left `ahead`, `behind`, `upstream` and the stack
parent unrendered even though every one of them was already in hand.

**The structural things were the least reachable.** Worktrees and stacks sat
two clicks deep in the sync toolbar's overflow menu, each opening a Sheet over
the diff. The branch list lived in a 288px popover hanging off the header chip.
Fetch and pull, which are one-tap habits, had top-level buttons. Meanwhile
`/workspace` mounted the entire `SourceControlPanel` a second time as a tab.

**Nothing measured the right thing.** The panel forked its layout on
`useMediaQuery("(max-width: 959.98px)")`, a question about the window, and used
the answer for a pane. Nested in a workspace tab, a 1000px window produced a
side-by-side split with no room for it. Separately, every right-side sheet
inherits `sm:max-w-sm` from `components/ui/sheet.tsx`, and because `cn()` is
tailwind-merge, where `w-*` and `max-w-*` are different conflict groups, a
caller setting only `w-[40rem]` never removed the cap. Blame and compare-refs
had been drawing at 384px on desktop, the same width as the tag list, while
overflowing a 375px viewport at the other end.

## Decisions

### D1. The branch-to-worktree join lands in Rust

`GitBranch` gains `checked_out_in` and `checkout_locked`, filled by a pure
`annotate_placements` over the worktree list. `git_branches` was already
`async`, so it does the sync libgit2 walk on `spawn_blocking` and the worktree
read after it.

The alternative was a client-side join in the store. It was rejected because
the panel is not the only consumer: the CLI, the agent-team isolation layer and
a paired companion all read this command, and a join done in the renderer
leaves each of them to reimplement it or go without.

The worktree read is `unwrap_or_default`, not `?`. A git too old for
`worktree list --porcelain -z` should cost the annotation, not the branch list
the whole panel is built on. An empty list degrades to "placement unknown",
which is exactly the behaviour that predates the field.

### D2. Placement decides the action, and the row says which

`lib/git/branch-placement.ts` is the single verdict: `here`, `otherWorktree`,
`free`, `remoteOnly`. The picker and the ⌘K provider both read it, so they
cannot disagree about what a row means.

The primary action follows: checkout for a free branch, **open that worktree**
for one another worktree holds, and `checkout -b x origin/x` for a remote-only
ref. Delete is offered only where git would accept it.

Placement is read from `isCurrent`, never from comparing `rootDir` against a
worktree path. Over a companion those are different coordinate systems, since
the panel's root is an opaque `git-workspace:<id>` target while worktree paths
arrive workspace-relative, and even locally they disagree under symlinks.

### D3. Two git refusals become questions

`BranchCheckedOutElsewhere` and `BranchNotFullyMerged` join `GitError`, matched
in `classify_failure` above the conflict arm because neither stderr contains
the word "conflict". `useGitActions` stops toasting the kinds a caller turns
into a next step, so a dialog and a toast no longer report one failure twice.

**Known boundary:** `companion_api/rpc/source_control` flattens every git
failure with `RpcError::internal(e.to_string())`, so `kind` does not survive a
paired transport and these paths fall back to the toast there. Recorded rather
than fixed here.

### D4. One navigator, and Source Control leaves the workspace tabs

Repository, worktrees, branches and stacks belong in one hierarchical
inventory, which is what VS Code, Fork and Sublime Merge all do: they are what
you move *between*, not what you *do*. The panel gains a Browse view holding
all three, reusing `WorkspaceEnvironmentList`, `BranchPicker` and an extracted
`StackList` rather than growing second copies of any of them. Sections read
only while open, because the column outlives every render of the diff beside
it.

`/workspace?tab=source-control` is retired. It put a `FeaturePageHeader` inside
a `FeaturePageShell`, and it bound a one-repository panel to a page whose
thesis is the workspace as the unit of work (ADR-0144), which can own several
roots. The strip keeps a link out and the deep link redirects: removing a
surface without leaving its entry point behind is how a feature becomes
unreachable. `?tab=environments` is untouched and remains the workspace-scoped
view of the same inventory.

### D5. The panel measures its pane, the compact tier measures the screen

`SOURCE_CONTROL_DENSE_WIDTH` (960) is a **pane** width, read through
`useElementWidth`. It decides how the panel arranges itself. `useCompactLayout`
(768px, or a native shell) is a **screen** question and decides which body
mounts at all. Both tiers stay, named, with the distinction written down.

`0` means "not yet measured" and reads as wide. Treating it as narrow would
stack the panes for one frame on every mount and then snap them apart.

### D6. Every right-side sheet is `w-full sm:max-w-*`

Never a bare width, because the base `sm:max-w-sm` survives one. Pinned by a
gate that parses the `<SheetContent>` tags and asserts a minimum tag count
first, so a sweep that matches nothing cannot pass vacuously.

### D7. ⌘K finds branches and worktrees, and never checks out

Two providers reading the store synchronously with `cache: false`. Commits and
stacks are deliberately not indexed: a provider runs on every keystroke, `git
log` search is the timeline filter's job, and a stack has no name a person
types. A row navigates to `/source-control?root=`, because a working-tree
switch from a fuzzy match is the worst outcome a palette can produce.

## Consequences

`git_worktree_list` had been answering `contract_output_violation` on every
companion, because its response schema declared four of the eight fields Rust
serializes under `additionalProperties: false`. Fixing that was a precondition
for reading worktrees at all, and it is a shipped bug independent of this work.

The fs watcher never matched `.git/worktrees/`, so `worktree add --detach`,
`lock`, `unlock` and `prune` emitted no refresh. That was survivable while
nothing rendered worktrees. It stops being survivable once a branch carries the
worktree holding it.

Adding a field to `GitBranch` moves `HEADLESS_CATALOG_HASH`, which the bridge
handshake compares. That is the ordinary cost of any contract change on this
branch, not a reason to keep the join in the renderer.
