---
title: "0138 — Reading-area layout stability"
description: "One scroll writer in the layout phase, the live tail out of the virtual list, and motion inside the transcript restricted to the compositor."
---

# ADR 0138 — Reading-area layout stability

**Status:** Accepted
**Date:** 2026-08-21

## Context

The transcript shook. Two reports, which turned out to share most of a cause:

- **while a reply streams**, the prose ticks up and back a pixel or two, most
  visible right under the caret;
- **when nothing is streaming** — a long tool-heavy turn, content already on
  screen — the foot of the column keeps twitching on its own.

The reading area is not a naive list, and every mechanism below was added for a
good reason. That is what made the jitter hard to see: each piece is defensible
alone, and the shaking is what they do together.

### The five scroll writers

`MessageList` wrote `scrollTop` from five places, each with its own gate:

| Writer | Fires on | Phase |
| --- | --- | --- |
| `useEffect` on `[messages, status, isAtBottom, autoScrollOnStream]` | every transcript commit | **after paint** |
| content `ResizeObserver` | deferred markdown, Shiki, images | pre-paint |
| viewport `ResizeObserver` | dock drag, window resize | pre-paint |
| `pinToBottom` via the thinking indicator's `onPhaseChange` | every tip rotation | **after paint** |
| `requestAnimationFrame` after the finalise re-measure | turn seal | **after paint** |

…all racing `virtual-core`'s own `scheduleScrollReconcile` rAF loop, with
`handleScroll` reading the result back into `isAtBottom` to close the circuit.

Three of the five ran **after the browser painted**. `useEffect` is not a
pre-paint hook: React flushes passive effects after the frame is on screen. So
every coalesced streaming commit went — paint the taller content (the reading
column jumps by the growth delta), then next frame correct the scroll back. At
roughly one commit per frame that is a continuous one-frame tremor, and it is
the whole of "the prose ticks up and back".

### The streamed row was sized by a projection

The row being streamed into was the one row inside the virtualizer with
`measureElement` deliberately withheld — measuring per token pumps the observer
— so its slot came from `Math.max(220, 220 + textLen * 0.55)`. The rendered text
grows in ~22px line steps; the projection grows 0.55px per character. Everything
downstream of `getTotalSize()`, including the `scrollHeight` the auto-scroll pins
against, therefore chased a number that was never the rendered height.

### Motion inside a measured box

`MotionCollapse` tweens `height` between `0` and `auto`. In a settings panel
that is one animation. In the transcript every row is watched by a
`ResizeObserver` — `measureElement`, plus the content observer behind the
auto-scroll — so it is **one layout change per frame for the length of the
animation**, each re-publishing the virtualizer's offsets and re-pinning the
scroll.

`content-visibility: auto` on every Streamdown block closed a similar loop from
the other side: a block flipping between rendered and skipped changes its height,
which changes the row's height, which moves the block, which flips it again.

### The thinking indicator is a permanent motion engine

This is the whole of "it shakes when nothing is streaming". The indicator runs
for the entire turn — minutes on a tool-heavy one — sitting directly under the
reply, and three things in it moved on timers:

- the label rotates a verb **every 3s** from mount, and a plain `<span>` changes
  width with it, shunting the bouncing dots sideways;
- the tip rotates **every 5s**; tips have different lengths so one wraps to two
  lines and the next to one, and `AnimatePresence mode="wait"` left the cell
  empty in between — the row collapsed and sprang back;
- each rotation called `onPhaseChange`, forcing a post-paint scroll pin.

In `compact` mode — content already on screen, i.e. most of a long turn — tips
still rotate, so this sat below the visible reply and shoved it.

### What was investigated and is NOT a cause

`parseIncompleteMarkdown` defaults to `true`, but `remend@1.3.0` completes only
**inline** markers (bold, italic, inline code, links, KaTeX, strikethrough). It
does not guess lists or tables. Block-level structure settling as tokens arrive
is inherent to streaming markdown, not a switch — it is absorbed by pinning in
the same frame, not by turning something off.

## Decision

### 1. One scroll writer, in the layout phase

`hooks/chat/use-stick-to-bottom.ts` is the sole owner of the transcript's
`scrollTop`. State-driven pins run in a layout effect (post-mutation,
pre-paint); the two `ResizeObserver` callbacks pin synchronously, since observer
callbacks are already delivered after layout and before paint.

Every write goes through one `pin()` that no-ops when the container is already
at the foot for the current `scrollHeight`. **"One commit → at most one scroll
write" is therefore an assertable fact**, not an aspiration.

Its scope stops at anchoring. Jumping to a message, the landing flash, the
return-here offer and the viewport-store publication are navigation, they are
not broken, and they stay where they are.

### 2. The live tail leaves the virtual list

Only settled messages are windowed. The row being streamed into and the thinking
indicator render in normal document flow beneath the virtual container, as one
`[data-slot="conversation-live-tail"]` region that owns the foot of the
transcript in both the virtualized and the document-flow branch.

Windowing had nothing to offer that row: it is always on screen, and it is
always last, so nothing below it can shift. Real height, real `scrollHeight`, no
projection — and the growing estimate plus the measure skip it existed to
compensate for are both deleted.

When the turn seals, the row rejoins the virtual list carrying `measureElement`,
which measures it during that same commit. Being last, nothing below it can be
pushed, so the handoff needs no seeded measurement — only a layout-phase re-pin.
The blanket `rowVirtualizer.measure()` on finalise goes with it: it discarded
every row's measurement to reconcile one row's projection.

Two contracts follow the row out of the window:

- `jumpToMessage` sends an index at or past `virtualCount` down the DOM-anchor
  path. The tail carries `data-msg-id` like any other row, and a find-bar hit on
  the streaming reply is exactly the case that lands there.
- the minimap adds the tail's height to the extent it normalises marker
  positions against, through a `getTailSize` **getter** — never a number, since
  the tail's height changes many times per second and must not re-render the
  list. The hook holds it in a ref so an unstable identity from a caller cannot
  churn its rAF loop.

### 3. Inside the transcript, motion may only touch the compositor

`opacity` and `transform` only. Anything that changes a box dimension either
goes, or is wrapped in a container that does not participate in measurement.

`ReadingCollapse` is `MotionCollapse` minus the height: the body takes its final
size in one layout pass and only the paint animates (a fast fade with a 2px
settle). Closing is instantaneous — there is deliberately no `AnimatePresence`,
because keeping the outgoing body mounted through an exit *is* the height
animation this exists to avoid. What is lost is the sense of the body unfurling;
what is gained is that expanding a card costs one reflow instead of seventeen.

The four reading-area disclosures use it — tool rows, activity groups, sub-agent
bodies, the thinking indicator. The ten settings-panel consumers keep
`MotionCollapse`, where nothing measures the box and the unfurl is worth having.

### 4. `content-visibility` only on settled messages

Dropped from the streaming block wrapper, kept on `FinalizedMarkdownSection`.
On the streaming path there is nothing off screen to skip, while the row IS
measured — so it was pure feedback loop. Settled messages genuinely do scroll
blocks out of view, and their remembered sizes are already true.

The wrapper stays for the one job it was needed for — hanging typeset's opt-out
on a block that renders a `<pre>` — and a block that renders no `<pre>` now gets
no wrapper element at all.

### 5. The thinking indicator keeps its expression, out of the layout

- the label sits in a grid cell sized by **every verb stacked invisibly behind
  it**, so the cell is as wide as the longest from the first frame and the swap
  is pure opacity. The dots never move.
- the tip box is a fixed two lines (`h-8` at `text-xs`) with the text clamped,
  and consecutive tips cross-fade in one shared grid cell rather than taking
  turns. No `mode="wait"`, no `y` offset.
- `onPhaseChange` is gone. `useStickToBottom` watches the content box, so the
  one growth that IS real — the skeleton and tip revealing — is followed without
  this row knowing anything about scrolling.

### 6. The caret is Streamdown's

`caret="block"`, not a hand-rolled element. Ours was a sibling of
`<MessageResponse>` inside `MessageContent`'s flex column, so it held a 16px row
plus an 8px gap under every streaming reply and vanished in one 24px step at the
seal. Streamdown renders `▋` as an `::after` on the last block: inline,
contributing no box, and it suppresses itself inside an unclosed fence — which
the sibling span never did. Reduced motion keeps the caret and drops only the
blink.

## Verification

### The metric is direction, not distance

`lib/chat/jitter-probe.ts` samples a position once per animation frame and
counts **direction changes**, not travel. Scrolling smoothly through a long
reply is a large displacement and no jitter at all; a px budget would flag it,
and would drift with content length, font and viewport width into a flaky gate.
A direction change in already-rendered content has a correct value of zero.

The gate is `reversals === 0` at a 0.5px epsilon — sub-pixel rounding must
neither manufacture reversals nor give a stationary sentinel a direction it
never had.

`Chat/MessageList → JitterProbe` in Storybook drives a fake stream at about one
commit per frame, samples the foot of the transcript, and prints the report.
This is the only place the failure is observable: jsdom has no layout engine, and
`__mocks__/motion-react.js` renders `AnimatePresence` children straight through
without ever running a timeline.

### The rule is executable

`components/chat/reading-area-motion.guardrail.test.tsx` reads the reading-area
sources and fails on an animated box dimension or a post-paint `scrollTop`
write. It is a source scan precisely because neither failure mode can be
reproduced in jsdom — the source is the only place to catch a regression before
the desktop shell. Adding a component to the reading area means adding its path
there.

## Consequences

- The transcript's scrollable extent is now a function of **settled messages
  only**, so it cannot breathe with every token.
- Expanding a tool card is a single reflow rather than one per frame for 280ms.
- The thinking indicator's expression survives — verbs still rotate, tips still
  cycle — but neither can reach the layout.
- Long tips are clipped at two lines. Accepted: the alternative is a row that
  changes height every five seconds under the reply.
- Disclosures in the reading area no longer unfurl. Accepted for the same
  reason; the fade still carries the change.
- The live tail is a second render path for one row. It is bounded (at most one
  message plus the indicator) and it is the path that removes the projection,
  the measure skip, and the finalise re-measure — a net reduction in special
  cases, not an addition.

## References

- ADR-0127 — message presentation, virtualization thresholds, rail coalescing
- ADR-0094 — anchors, jumps and permalinks (the navigation half of scrolling)
- `hooks/chat/use-stick-to-bottom.ts`, `lib/chat/jitter-probe.ts`
- `components/chat/motion/motion-reveal.tsx` (`ReadingCollapse`)
