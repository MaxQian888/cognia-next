---
title: "0094 — Conversation Anchors and Jumping"
description: "One jump implementation with a stated landing intent, one floating offer at the foot of the pane, a timeline rail that no longer sits on the scrollbar, and message permalinks that finally close ADR-0033's deferred locate-in-conversation."
---

# ADR 0094 — Conversation Anchors and Jumping

- **Status:** Accepted
- **Date:** 2026-07-29
- **Closes:** ADR-0033's deferred follow-up ("Message-level locate-in-conversation — needs a chat scroll-to-message anchor")
- **Related:** ADR-0037 (public share links — deliberately a different thing, see below)

## Context

Navigating a long conversation was already 60% built and nobody had noticed the other 40% was
missing, because every gap failed *silently*.

`chatViewportStore` published a single `jumpToMessage`; the right-edge `minimap/` timeline derived
turns and rendered a rail; `⌘F` searched; messages could be starred. All of it was genuinely wired
— none of it was dead code. But:

- **The jump control was invisible exactly when it existed.** It was an `absolute bottom-4` child
  of the scroll container, which makes it part of the scrollable content: positioned against the
  unscrolled box, and scrolled away with the messages. It only rendered when `!isAtBottom`, i.e.
  once the user had scrolled up — the same condition that carried it off-screen. It also had no
  accessible name and no string in either locale.
- **Jumps could resolve to nothing, quietly.** The virtualized render branch emitted `data-index`
  but not `data-msg-id`, so the DOM path of `jumpToMessage` could never match. The artifact dock's
  "go to source" called it without an index, so a compacted-away message produced a click that did
  nothing at all — indistinguishable from a broken button.
- **Every jump landed the same way.** `align: "center"` was hard-coded, so a timeline anchor —
  which is the user's own *question*, whose point is to read the reply below it — was parked
  mid-screen under the tail of the previous turn.
- **Arriving was unverifiable.** Nothing marked the landing row. In a long, repetitive
  conversation "did that go where I meant?" is a real question, and scrolling silently is
  indistinguishable from scrolling to the wrong place.
- **There was no way back.** Jumping was cheap; returning meant scrolling and hoping.
- **The rail sat on the scrollbar.** `absolute right-0 z-20` over a scroll container with no
  thin-scrollbar styling: on any platform with classic (non-overlay) scrollbars, the 16px rail
  swallowed every scrollbar drag.
- **The rail was invisible at rest and mouse-only.** Markers at `bg-muted-foreground/40`, a grip at
  `opacity-0` until hover, `mousemove` only, `aria-hidden`, `tabIndex={-1}`. Nothing to discover.
- **The panel opened at turn one.** In a 200-turn conversation, the one thing the reader already
  knows is where they are, and that is what the panel did not show.
- **Starring an answer pointed at the question.** A turn counted as bookmarked when any message in
  it was starred, but the panel only ever displayed and jumped to the user message — so the one
  thing you bookmarked was the one thing the bookmark could not reach.
- **No message permalinks.** ADR-0033 had already deferred terminal "locate in conversation" to
  message level for want of a scroll-to-message seam.

## Decision

### One jump, with a stated intent

`jumpToMessage(messageId, index?, { align })` returns a **boolean**. `align` is the caller's
semantics, not a style: `start` for a timeline anchor (read downwards from it), `center` for a
search hit or an artifact's source (a point of interest to look at). Both render branches emit
`data-msg-id`; the selector escaping lives once in `lib/chat/message-anchor.ts`.

Callers must surface `false`. "The message is not reachable" is a real, ordinary state — compacted
away, or owned by a session that is not open — and it is now a toast rather than a dead click.

**No landing-position correction loop.** `@tanstack/react-virtual@3.14.8` resolves
`virtual-core@3.17.6`, which already runs `scheduleScrollReconcile`: a rAF loop that re-targets
each frame until the offset is stable, capped at 5s. A second corrector would read the library's
in-flight scroll as drift and fight it.

### Arrival is marked

`useJumpFlash` holds the landed-on message for ~1.2s (scaled by `motion.speed`), and `JumpFlash`
paints a wash plus a leading bar over that row — `opacity`/`transform` only, so flashing a row
inside a tool-dense reply costs no layout. A nonce makes a repeat jump to the *same* message
re-mark it, which matters because repeating the action is exactly what a user does when unsure it
worked. Reduced motion holds the mark flat instead of animating it away.

This is deliberately distinct from the find bar's `activeHitId` ring, which persists until the user
steps to the next match. Both can be on the same row.

### One floating offer, not three buttons

A single pill at the foot of the pane, morphing between three states — `↩ back to where you were`,
`↓ N new messages`, `↓ jump to latest`. `return` wins when on offer: it is the only one that
expires, and it answers something the user deliberately asked for seconds ago. The precedence rule
lives in a pure `resolveJumpPillMode` so it is testable without a DOM.

It renders **outside the scroll container**. That is the fix for the invisibility bug, and it is
not unit-testable — jsdom has no layout — so `tests/e2e/mobile/conversation-anchors.spec.ts`
asserts the pill's bounding box is inside the viewport after scrolling up.

That spec runs on the Capacitor shell rather than the desktop browser project, because the browser
build renders a "run inside Tauri" banner where the chat pane would be. The `chromium` project
`testIgnore`s `tests/e2e/mobile/**`, so the pill's geometry is covered on exactly one project.
**The right-edge timeline rail's geometry — its lane beside the scrollbar, and its at-rest
visibility — has no E2E coverage**: the rail is desktop-only (`shouldMountTimeline` bails on
mobile), so the one project that renders it is `tauri`, which is opt-in and serial. Its behaviour is
unit-tested; its layout is not.

The return point is a scroll *offset*, not a message id: what the user wants back is the view they
had, and the message they were reading may not be a turn anchor. A single slot rather than a stack
— chaining "back" through five jumps is a browser-history model nobody asks a transcript for. It
expires after 8s and is dropped when the user scrolls under their own steam, because a stale back
button promises a place they stopped caring about.

A jump's own scrolling is indistinguishable from the user's at the event level, so it is fenced off
by a 700ms window. Overshooting keeps the offer a moment longer than needed; undershooting drops it
— the safe direction.

### The rail gets a lane

Both timeline states are now in flow. The collapsed rail's own 16px lane costs the reading column
almost nothing and hands the scrollbar back. Markers sit at `/55` and widen from dots to dashes on
hover; the grip is faintly visible at rest rather than fully transparent. Pointer events replace
mouse events (a stylus got no scrub preview at all), and the viewport thumb is draggable, mapping
the rail onto the scroll range as the exact inverse of how the thumb is placed
(`scrollTopForThumb`).

### The panel shows where you are

Opening it centres the active turn. Sticky date headers mark where each calendar day starts, since
a hundred rows of bare clock times say nothing about a conversation resumed across days. When the
star is on an assistant reply, the row jumps to *that reply* and says so — without changing the
`TimelineTurn` model, which the rail markers and scroll-sync geometry both index into.

Rows arrive with a staggered `MotionReveal`. The panel's 256px width lands in a single layout pass
rather than tweening: a width tween would rewrap the reading column and force the main list's
virtualizer to re-measure every frame. The headers are rendered *outside* the reveal wrapper —
`MotionReveal` leaves a transform, and a transformed ancestor becomes the containing block for
`position: sticky`, so a nested header would stick to its own 40px row.

### Message permalinks — and the ADR-0033 follow-up

`/?session=<id>&message=<id>`, following the static-export deep-link idiom (`useSearchParams`
inside a `<Suspense>` boundary; a dynamic `[id]` route cannot exist under `output: "export"`).

**This is not a share link.** ADR-0037's share links publish a copy of a conversation to a URL
anyone can open; a permalink is private navigation that only resolves inside this app, against this
user's local database. The UI keeps them verbally distinct ("Copy link to message" vs "Share"),
because handing someone the wrong one is either a privacy accident or a dead link.

Consumption waits for the target session's history to hydrate — the list can only scroll to a row
it renders — then jumps and strips the query via `replaceState`. Stripping is not cosmetic: leaving
the query in place re-fires the jump on every later render and pins the view to the linked message.
A 10s ceiling gives up on a stale id rather than staying armed and firing at whatever appears next.

Terminal tabs record `agentSpawnerMessageId` at spawn, **inferred renderer-side** as the session's
last assistant message. The plugin-tool wire carries only a session id, and threading a message id
through it would touch the sidecar↔renderer contract and every plugin-tool call site — to buy
exactness in a case where being one message out still lands the user on the right part of the
conversation. Tabs spawned before this field existed fall back to the plain route.

## Consequences

- The rail's 16px lane narrows the reading column by 16px once a conversation passes
  `TIMELINE_THRESHOLD` on a wide enough pane. Accepted: the 256px expanded panel already displaces
  the column, so this is consistent, and it is the only way to stop the rail eating scrollbar drags.
- `agentSpawnerMessageId` can be one message out under a replay or a second turn racing the first.
  It degrades to landing near the right place, never to failing.
- The permalink is only meaningful inside this app. Pasted elsewhere it is a dead link — which is
  why the copy affordance is worded as a link to a message, not as sharing.
- `jumpToMessage`'s return type is now load-bearing. A caller that ignores it reintroduces exactly
  the silent-failure class this ADR removes.

## Lives in

`lib/chat/message-anchor.ts`, `lib/chat/message-permalink.ts`,
`hooks/chat/use-jump-flash.ts`, `hooks/chat/use-jump-history.ts`,
`hooks/chat/use-message-permalink.ts`, `components/chat/jump-flash.tsx`,
`components/chat/conversation-jump-pill.tsx`, `components/chat/minimap/`,
`components/chat/message-list.tsx`, `stores/chat/chat-viewport-store.ts`,
`lib/terminal/spawner-message.ts`, `tests/e2e/mobile/conversation-anchors.spec.ts`
