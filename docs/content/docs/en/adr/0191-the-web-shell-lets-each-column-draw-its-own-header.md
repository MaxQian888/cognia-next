---
title: "0191 — The web shell lets each column draw its own header"
description: "The desktop title bar — drag regions, menubar folding, window controls, eleven customizable segments — was mounted verbatim on the browser shell, where it read as a second window frame inside a tab that already has one. The web shell now defaults to no top bar at all: the conversation rail, chat column, and workbench each draw their own 40px header through the projection system's existing inline fallback, the workspace switcher stays in the rail's header, and the toolbar.* plugin extension points re-home onto the chat column header. A persisted setting (`webTitleBarEnabled`) brings the bar back for users who want it; Tauri is untouched, where the bar is the window chrome and cannot leave."
---

# ADR 0191 — The web shell lets each column draw its own header

**Status:** Accepted — implemented
**Date:** 2026-10-22
**Related:** [ADR-0129](./0129-unified-global-search) (the command palette that outlives the bar), [ADR-0122](./0122-first-run-onboarding) (the other place the shell yields its frame to a route), [ADR-0144](./0144-workspace-as-the-unit-of-work) (the workspace switcher the rail header carries)

## Context

The desktop `TitleBar` was built for Tauri's `decorations: false` window: it is
the drag surface, the menubar, and the home of the close/min/max buttons, and
on top of that it carries eleven customizable segments — app icon, nav arrows,
workspace, search pill, command center, four panel toggles. When the outlets
system (see `components/shell/title-bar-outlets.tsx`) was added, the column
headers also started *projecting* into it, so the one 40px row additionally
hosts the rail, chat, and dock headers.

On the browser shell all of that landed inside a tab that already has chrome.
The bar was a second window frame: `bg-muted/40` tinted, stacked with entries
that duplicated each other (three overlapping doors to the command palette;
nav arrows that duplicate the browser's own back; window controls wired to
nothing) and to which every column's header had surrendered its own identity.
In a browser the result read as weight, not consolidation.

The projection system already contained the escape hatch: when a zone's outlet
does not exist, `useTitleBarProjection` returns `null` and the column header
draws inline. The mobile Sheet had always run that way. What was missing was a
way to say "on web, there is no bar" — and answers for the things the bar
alone carried.

## Decision

**On the browser shell the top bar is a setting, off by default.** `ui-store`
gains `webTitleBarEnabled` (persisted, default `false`), toggled from
Settings → Shell layout → Top bar, where the item list stays editable as the
layout the bar comes back with. On Tauri the flag is ignored: the bar is the
window chrome and stays unconditional.

With no bar mounted, the shell inverts to column-owned chrome:

- **The conversation rail** keeps the merged workspace reading — nav rows,
  scope tree, footer — because `merged` now means "the expanded left-edge rail
  inside the workspace scope" rather than "the start outlet exists". Its
  header draws the projected row's content inline: `WorkspaceContextBar`
  (workspace switcher + branch), the search magnifier, and the ⋯ list actions.
- **The chat column** draws `ChatHeader`'s inline row, which already carries
  its own sidebar and dock toggles. The `toolbar.left` / `toolbar.center` /
  `toolbar.right` plugin extension points move here — the only shell chrome a
  conversation route owns — gated on the projection scope so hosts outside the
  workspace (inbox detail, Canvas sidechat, the mobile Sheet) stay plain.
- **The workbench/artifact dock** draws its own header via the same fallback.
- **The home hero** has no column header at all — pure content.

What survives without the bar: the command palette (the dialog binds its own
⌘K/Ctrl+K and the rail's search field still hands a typed query up to it), ⌘B
sidebar toggle, the status bar, the Find bar, and the shell layout customizer.
What does not exist on the bar-less web shell: the in-app nav arrows (the
browser's back covers them), the bar's own menus (⌘K covers them), and
`TitleBarWorkspace`'s separate chip (the rail header's switcher is the same
component).

## Consequences

- **The default web experience loses a full row of chrome** and every column
  keeps its context visible — workspace + branch on the rail, conversation
  title on the chat, panel name on the dock.
- **`merged` is a property of the column, not of projection.** A rail mounted
  outside the workspace scope keeps the compact reading on every platform;
  the change is scoped to exactly the intended case.
- **Plugin `toolbar.*` points follow the chat column.** On non-chat web routes
  (settings, workflows) they have no host — deliberate: they were always
  conversation-adjacent chrome.
- **Tauri is byte-for-byte unchanged**: `shellHasTitleBar` is always true
  there, so `merged` resolves exactly as before, and the bar's outlets,
  drag regions, menubar, and window controls are untouched.
- **The flag is per-browser** (localStorage persist, like the other chrome
  prefs) — a deliberate reading of "this browser window's frame is already
  occupied".

## Implementation

- `stores/ui/ui-store.ts` — `webTitleBarEnabled` + `setWebTitleBarEnabled`,
  persisted via `partialize`.
- `components/desktop/desktop-app-shell.tsx` — mounts `TitleBar` only when
  `platform === "tauri" || (platform === "web" && webTitleBarEnabled)`;
  unmounted rather than hidden so the outlets never register.
- `components/desktop/channel-list.tsx` — `merged` becomes
  `railExpanded && inScope && (headerOutlet !== null || !shellHasTitleBar)`;
  `Header` draws the workspace row inline when `workspaceChrome` is set.
- `components/chat/chat-header.tsx` — hosts `toolbar.*` slots when the header
  draws inline inside the projection scope.
- `components/shell/title-bar-outlets.tsx` — new `useTitleBarProjectionScope()`
  exposes the scope flag that used to be private.
- `components/shell/shell-layout-customizer.tsx` — the web-only switch on the
  Top bar tab.

Tests: `desktop-app-shell.test.tsx` (mount gating per platform + flag),
`channel-list.test.tsx` ("web shell without the title bar" describe),
`chat-header.test.tsx` (slot hosting in/out of scope and while projected),
`title-bar-outlets.test.tsx` (the scope hook), `shell-layout-customizer.test.tsx`
(the switch on web only), `ui-store.test.ts` (default, setter, partialize).
