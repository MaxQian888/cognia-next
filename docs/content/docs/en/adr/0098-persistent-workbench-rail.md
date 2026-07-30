---
title: "0098 — Persistent Workbench Rail"
description: "Collapsing the Context Workbench leaves its activity rail on screen, makes that rail draggable back open with release-snapping, and gives the host's real visibility to the plugin contract."
---

# ADR 0098 — Persistent Workbench Rail

**Status:** Accepted
**Date:** 2026-07-29

## Context

ADR-0083 gave every right-side surface one shell with a 48px activity rail. Three of its four hosts — the chat artifact dock, Canvas and the workflow editor — then collapsed that shell to **zero width**, unmounting it entirely. Once shut, nothing on screen said the preview, review, AI, comments and workspace panels existed; the only way back was remembering ⌘J. Only the project editor, which passes no `onCollapse`, ever reached the workbench's own `mode: "collapsed"` and kept its rail.

Three defects followed from the same seam:

- **The toggle went dead for one press.** `react-resizable-panels` collapses a `collapsible` panel by itself once a drag crosses `minSize`. No host wrote that back, so the dock sat visually shut while `dockCollapsed` stayed `false`; the next ⌘J spent itself calling `collapse()` on an already-collapsed panel.
- **`isPluginContextPanelVisible` lied.** It read the per-scope `layout.mode`, which those three hosts never write, so a plugin's `onDidChangeVisibility` reported "visible" while the whole right column was at zero width.
- **`setMode("collapsed")` was dormant** for the same reason: it wrote a field the container's owner does not read.

## Decision

Collapsing shrinks a host's container to the activity rail instead of to nothing, and the rail is draggable back open.

- **`railOnly` is host-driven, not per-scope.** `ContextWorkbench` takes a `railOnly` prop and merges it with the existing `mode: "collapsed"` into one internal `bodyHidden`. "Is the right column open" is one global fact per host; routing it through `contextWorkbenchStore.layouts[scopeKey]` — which is keyed per *resource* — would make the dock re-open and re-close as the user moved between artifact tabs.
- **The body unmounts, it is not hidden.** Rail-only drops the whole panel container, so the embedded browser's process-wide webview lease is released exactly as a zero-width dock released it. The chat dock delays the flip by one collapse animation so the shrinking shell wipes real content.
- **Snapping settles on release, never during the drag.** `lib/ui/panel-snap.ts` is one unit-agnostic pure function shared by all four hosts: below the floor → collapsed; out of the rail → the remembered width; within a physical 24px of a width preset → that preset. A live magnet would have to write back from inside the layout callback the resize triggers.
- **`ActiveContextHost` gains `isVisible` and `collapse`**, the duals of the existing `ensureVisible`. Visibility flips are announced with `notifyActiveContextHostVisibility`, which notifies without re-registering — re-registering would restamp a collapsing background host as the active one.
- **`workbenchRailPersistent` is its own `AppSettings` key**, default on, edited beside the rail customizer. It is separate from `workbenchRail` for the reason `sidebarSide` is separate from `sidebarLayout`: that type's mutators rebuild their object, and its "restore defaults" means "put my activity order back", which must not also switch the rail off.

Desktop only. Narrow screens keep the full-height Sheet: a 24% dock on an 820px tablet is ~197px, and the Sheet hosts the same workbench over the same resource.

## Consequences

Every right-hand column now costs a permanent 48px unless the user opts out, and with `sidebarSide: "right"` the edge carries two icon columns (64px navigation + 48px workbench). That is accepted: the two rails have different jobs, and the switch is the escape hatch.

`workbenchRailPersistent` is honoured by the three hosts that own a container and deliberately **not** by the project editor, which has none: its collapse has always been rail-only, and there is no user-reachable way to bring the surface back once it is gone (`showContextWorkbench` is a caller prop, not a control), so a zero-width collapse there would strand the workbench. Pinned by the workbench test that a `manageOwnWidth` host with no `onCollapse` still reaches rail-only through the per-scope mode.

The workflow editor's desktop branch previously ran two competing notions of "shut" — a local `rightCollapsed` state over a zero-width panel, plus the per-scope mode its sidebar fell through to. It now passes `onCollapse`/`onEnsureVisible` like every other host, leaving one owner.
