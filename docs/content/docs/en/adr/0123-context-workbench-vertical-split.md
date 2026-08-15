---
title: "0123 — Context Workbench Vertical Split"
description: "Renders the two-pane split that ADR-0121 recorded as dormant, using absolutely-positioned lanes rather than a resizable group so neither pane is ever rebuilt."
---

# ADR 0123 — Context Workbench Vertical Split

**Status:** Accepted
**Date:** 2026-08-15

## Context

ADR-0121 recorded three features that were built, persisted and invisible.
`splitPanelId` / `splitRatio` and their three store actions were one of them:
complete in the model layer, normalized and clamped on every read, with no
renderer behind them. Per Working Rule 7 the dormancy was stated on all three
axes — a doc comment on the type, a disabled "Split view (not available yet)"
entry in the layout menu, and a test pinning both.

This removes that dormancy. The state machine was the settled half; what was
missing was a body that could show two panels at once without destroying
either.

## Decision

### Lanes, not a resizable group

The hard requirement is that opening, closing, resizing **and swapping** the
split never rebuild a mounted panel. The panels that matter here are the
expensive ones: the embedded browser holds a process-wide webview lease, the
workspace holds Monaco buffers, the terminal holds a pty.

React reconciles by type and key *at a position*, so moving a panel into a
`<ResizablePanel>` changes its parent chain and remounts it. A swap changes
both panes' chains at once. Portals do not help — `updatePortal` compares
`containerInfo`, so a changed container is a delete plus a create.

The structure that survives is one stable container with one stable wrapper per
panel, where only inline box geometry changes. `absolute inset-0` became
`absolute inset-x-0` plus an inline `top`/`bottom` or `top`/`height`. It is the
same element, same key, same parent in every configuration: React updates
attributes instead of reconciling a subtree. In the single-pane case the
computed box is identical to before.

`components/source-control/diff-pane.tsx` remains a good precedent for a
persisted vertical split, but not for this one — its two children are never the
same component moving between slots.

### Lifecycle keys on the visible set

`onFirstActivate` / `onRestore` were keyed on the single panel in front, which
cannot answer the question a second pane asks. Swapping the panes changes which
panel is in front while nothing enters or leaves the screen; dragging the
separator changes neither.

The one ref became two, by the question each answers. `lastActivePanelRef`
still means "is this a navigation?" and drives the back/forward history.
`lastVisiblePanelsRef` means "did anything appear or disappear?" and drives the
callbacks. Only a panel entering the visible set gets one, so a swap is silent
and a drag is silent.

### `narrow` closes a split; `collapsed` does not

Narrow has no room for two stacked panes, so it closes the split. Collapse is a
visibility state, not a layout one: `bodyHidden` merges the per-scope
`collapsed` mode with the host-driven `railOnly` precisely so the two collapse
routes cannot disagree, and `railOnly` hosts cannot write the store at all.
Closing on collapse would make one route destructive and the other not.

A panel's `preferredMode` also stops narrowing while a split is open. Nearly
every panel reaches `reveal` with a defaulted `"narrow"` preference, so
honouring it would close the split on the very next rail click and the swap
could never be observed. `preferredMode` is a preference, not an instruction;
an explicit `setMode("narrow")` still closes it.

### The migration clears a field it also keeps

Persist version 2 → 3 clears `splitPanelId` but preserves `splitRatio`. Before
v3 both were dormant — no renderer read them, so any stored `splitPanelId` is a
leftover default or a hand-written value, never a layout a user chose, and
restoring it would paint a second pane nobody asked for on the first load after
upgrade. The ratio is a remembered preference like `panelWidths`, so re-opening
a split lands where the user last left it.

Only the migration clears it. `partialize` and `merge` must not, or a live
split would not survive a reload.

### Projections, not writes

The mobile drawer and any body narrower than 480px render a single pane while
leaving `splitPanelId` intact. A phone — or a drag below the threshold and back
— therefore cannot destroy a desktop layout.

This is why `isPluginContextPanelVisible` asks the host rather than the layout.
`ActiveContextHost` gained `visiblePanelIds()`, and the check prefers it,
falling back to the layout for hosts that predate the option. Reading
`splitPanelId` directly would report a second pane as visible on a device that
is not drawing one — the same class of lie `isVisible` was added to fix in
ADR-0098.

### Accessibility

Two visible tabpanels under one selected tab is not a tabs widget. While split,
both panes become labelled regions and the group tab strip degrades to a button
group reporting `aria-pressed`. Keyboard navigation is unaffected: it queries
the panel data attribute, not the role. The separator is a focusable window
splitter with `aria-valuenow` / `min` / `max`, arrow, shift-arrow and Home/End.

### Persistence during a drag

The pointer drag mutates only a `--wb-split` custom property and commits to the
store once on release. A store write per pointer move would re-render the whole
workbench — and with it a Monaco buffer, an embedded browser and a terminal —
mid-gesture, for a number nothing else reads until the drag ends. Keyboard
resize commits immediately, since a key press is already a finished gesture.

## Consequences

- `splitPlanned` and its disabled menu entry are gone. Where there is no room
  the menu now says what to switch to instead of only that it cannot.
- `ContextPanelRenderProps.active` means "in a visible pane", true for both
  panels while split. It drives `inert`, `aria-hidden`, `<Activity>` and the
  plugin webview visibility event, all of which follow without further change.
- `PluginContextWorkbenchState` gained `splitPanelId` and `splitRatio`.
  `ownsActivePanel` still means the panel in front: `setMode` and `setPinned`
  reshape the whole workbench, and a plugin in the lower half has not been
  handed the surface.
- No plugin-facing split, reparent or move method. Adding one before a consumer
  exists would recreate exactly the dormancy this ADR removes.

Supersedes in part ADR-0121, whose "three dormant features" section still
describes split view as unrendered.
