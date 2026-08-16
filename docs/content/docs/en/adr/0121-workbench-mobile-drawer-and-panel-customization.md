---
title: "0121 — Workbench Mobile Drawer and Panel Customization"
description: "Moves the mobile Context Workbench onto a real vaul drawer with snap points, adds panel-level reorder/hide beneath the activity rail, and makes three dormant customizations legible instead of silent."
---

# ADR 0121 — Workbench Mobile Drawer and Panel Customization

**Status:** Accepted
**Date:** 2026-08-15

## Context

ADR-0083 gave every right-side surface one shell; ADR-0098 kept its activity rail
on screen when the panel body is shut. Three seams were left behind.

**The mobile surface promised gestures it did not have.** The narrow-screen host
was a Radix `Sheet` with a decorative `aria-hidden` bar and a comment claiming it
"keeps the grab-handle affordance and the swipe-to-dismiss gesture". `Sheet` is a
Dialog: it has neither. `artifact-panel.tsx` repeated the claim. Around that
absence sat a fixed `h-[92dvh]` with no half-open state, 32px activity buttons
against the 44px floor `globals.css` sets for the rest of the app, no
`useBackDismiss` (so Android back tore the route out from under the sheet while
twenty-odd other mobile sheets handled it), and no keyboard avoidance — the sheet
is portalled outside `mobile-shell-wrapper`'s layout, so its bottom reserve never
reached the composer inside the AI and comments panels.

**Customization stopped one level too high.** Users could reorder and hide the
seven *activities*; the eleven-to-thirteen *panels* inside them were ordered by a
hardcoded `order:` number and could not be hidden at all.

**Three features were built, persisted, and invisible.** `splitPanelId` /
`splitRatio` with three store actions, `WorkbenchRailLayout.groups`, and
`workbenchRailPerProject` are each complete in the model layer with no reader —
and none said so anywhere a user could look, which is precisely the shape
Working Rule 7 exists to prevent. One of them was also losing data:
`useWorkbenchRailLayout.hide` rebuilt `{ order, hidden }` from scratch while
`show` spread the layout, and `workbenchRailLayoutOf` dropped `groups` on read,
so any stored group would have been deleted by the next hide.

## Decision

### The mobile surface is a vaul drawer, and it unmounts when closed

`ContextWorkbenchMobileDrawer` replaces `ContextWorkbenchMobileSheet`. vaul is
already in the tree and used by six other surfaces; the affordances the comments
described become real rather than being described again.

- **Snap points `[0.55, 0.92]`**, with `fadeFromIndex` on the last one only — at
  the half-open snap the point is to keep reading the conversation above, so it
  must not be dimmed. The active snap is hoisted to
  `artifactDockLayoutStore.mobileSnapPoint` because closing unmounts the drawer;
  component state could not survive a close/reopen. The shared `ContextWorkbench`
  takes it as a prop rather than importing that store, which would cross the
  layering four hosts depend on.
- **`handleOnly`.** The body hosts Monaco, a scrollable file tree and an embedded
  browser pane. A drag-anywhere surface would fight all three. vaul's handle
  carries a 2.75rem hit area of its own.
- **No `forceMount`.** The Sheet kept itself mounted off-canvas and leaned on
  `inert` + `aria-hidden` to keep a closed surface unreachable; vaul owns its
  exit animation and then drops the surface, which is the same guarantee without
  two attributes that have to agree. Nothing is lost: the `<Activity mode="hidden">`
  wrapper already destroyed panel effects on close, so the embedded browser's
  process-wide webview lease was never held open by a closed sheet — and the
  desktop dock has always unmounted its body on collapse. Mobile was the outlier.
- **`repositionInputs={false}` plus a measured `keyboardHeight` padding.**
  Capacitor ships `Keyboard.resize: "native"`, which resizes the whole WebView
  frame; letting vaul reposition on top of that moves an input twice.
  `useKeyboardInsets` reads 0 there by design and the real overlap on mobile web,
  which is the platform that actually needed the lift.
- **The transition duration is re-expressed on the property vaul animates.** The
  Sheet scaled its slide by `--motion-duration-scale`; vaul hardcodes
  `transition: transform .5s`, so the same contract now rides
  `[transition-duration:…]!`. The reduce-motion guards in `globals.css` are more
  specific and continue to win.

`onCollapse` is `Omit`ted from the drawer's props and supplied internally. It is
not a tidiness change: `handleCollapse` falls through to `setMode("collapsed")`
when no host provides one, which in a drawer hides the *body* inside a 92dvh
modal **and persists**, so it reopens empty. `project-context-workbench.tsx`
mounted the mobile surface without an `onCollapse` and was in exactly that state.
Taking the prop away makes that unreachable rather than merely fixed.

On this placement the rail's trailing button reads **Close** with an `X`, not
"Collapse workbench" over a right-panel glyph, and the VS Code convention of
re-clicking the active activity to shut the surface is suppressed — in a drawer
that turns a mistimed second tap into dismissing everything, and the drawer
already has three deliberate exits.

### Panel-level customization sits under the rail, not beside it

`settings.workbenchPanels` (`{ order, hidden }`, resolved through the shared
`resolveOrderedLayout`) orders and hides the tabs *inside* an activity.

- **Hiding removes the tab, never the panel.** It stays in `resolvedPanels`, so
  `publishActiveContextPanels`, the command palette, `Ctrl+Shift+E` and
  `Ctrl+1..7` still reach it. That fallback is the whole reason hiding is safe to
  offer, and it is the identical rule activities already follow.
- **An activity whose every panel is hidden loses its rail button too** — an icon
  that opens an empty body is worse than no icon, and the panels stay reachable
  by shortcut either way.
- **A static catalog with a parity test.** Panel definitions are built inside
  hooks closing over session state, so nothing can be enumerated at rest and the
  customizer (reachable from Settings) has no live workbench to ask.
  `WORKBENCH_PANEL_CATALOG` duplicates identities that really live in
  `chat-dock-panels.tsx`, and `workbench-panels.test.ts` scrapes that source to
  hold the two in step — the same answer `taxonomy-parity.test.ts` already gives
  for the activity taxonomy.
- **One `CustomizerLists` per activity.** A panel's order only means anything
  relative to its own group, so a single flat list would invite drags the UI
  cannot honour. Each section commits back into the one flat stored order.
- The editor renders under the rail editor on the existing **Workbench** tab. A
  separate tab would have made the user guess which of two entry points owned
  "the workbench".

### Dormancy is stated where a user can see it

> **Superseded in part by ADR-0123.** Split view is no longer dormant: it
> renders, and `splitPlanned` together with its disabled menu entry has been
> removed. Rail panel groups and the per-project rail layout are unaffected and
> remain dormant as described below.

Split view, rail panel groups, and the per-project rail layout each gain
Working Rule 7's missing axes: the type says why it is dormant, the UI says it is
planned, and a test pins both. The shape follows
`settings/external-bridge/panels/scopes-panel.tsx` — a disabled control, a
"planned" badge, and a reason. The workbench's layout menu also stops hiding
itself above `@[20rem]` when the host supplies no reset action, because that menu
is now the only place split view is named.

The `groups` data-loss path is fixed with the label: both `hide` and
`workbenchRailLayoutOf` carry the field through. Dormant has to mean "not used
yet", not "quietly erased".

### The conversation column gets an absolute floor

`CHAT_MIN_PX` (420px), applied as `dockCapForChatFloor` — a cap on the dock
rather than a floor on the chat, because the panel library takes one unit per
bound and a cap covers every entry point at once (drag, the narrow/wide presets,
double-click, a width restored from a wider window).

The dock's percentages are shares of its `ResizablePanelGroup`, and that group is
not the window: a right-docked terminal takes its cut at the shell row first, and
with `sidebarSide: "right"` two icon columns sit outside it too. On a 1280px
screen with a 30% terminal, the workspace profile's 65% left ~315px of
conversation. The cap is refreshed from the measured group width in
`onLayoutChanged`, which already fires on mount and every resize, so no observer
is needed.

## Consequences

Closing the mobile workbench now tears down its panels, so transient in-panel
state (scroll offsets, an unsent comment draft) does not survive a close. That
matches the desktop dock, which has always done this, and it is what lets vaul
own the exit animation instead of being fought with `forceMount`.

`WORKBENCH_PANEL_CATALOG` is a second copy of identities declared in
`chat-dock-panels.tsx`. The parity test is what makes that acceptable; a panel
added without a catalog entry fails it rather than becoming silently
un-customizable. Canvas, the workflow editor and the project editor contribute
their panels inline and are deliberately absent — adding them is an append plus a
line in the test.

A real shared width budget across the three independently-owned right-edge
surfaces is still not modelled. `CHAT_MIN_PX` is the cheap half: whatever the row
has been narrowed to, the dock cannot take the conversation below a width that
reads.
