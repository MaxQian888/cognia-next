---
title: ADR-0052 — Agent CLI TUI fixed-region (fullscreen) layout
description: "Give the cognia-agent Ink TUI a fixed banner / fixed composer / scrollable-middle layout in the terminal's alternate screen buffer, with an app-managed scroll viewport. Default fullscreen, capability-gated to scrollback on a non-TTY, and live-toggleable via /layout. Documents the deliberate trade-off (no native scrollback) and the mouse mode toggle (/mouse) that trades wheel-scroll against native text selection — default scroll."
---

# ADR-0052 — Agent CLI TUI fixed-region (fullscreen) layout

**Status**: Accepted (2026-06-20)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the [Agent CLI TUI](../subsystems/cognia-agent-tui) subsystem and ADR-0050 (TUI operation-experience hardening).

## Context

The TUI historically composed the screen with Ink's `<Static>`: committed
transcript cells were written **once into the terminal's native scrollback** and
never re-rendered, while only the bottom "live frame" (the in-flight turn, the
composer, the mascot, the footer) was React-managed. This is the same model
Claude Code and Codex CLI use, and it has real virtues — native terminal
scrolling, text selection, and copy all work, and long sessions stay cheap
because old cells are never repainted.

It also means **nothing is truly fixed**. The welcome banner was the first
`<Static>` row, so it scrolled up out of view as the conversation grew; the
composer only *looked* pinned because the live frame is always the bottom-most
painted block. The request was for a genuine fixed-region layout: a banner
pinned to the top, the composer pinned to the bottom, and a scrollable middle —
the vim / htop / lazygit shape.

That shape is **incompatible with the `<Static>`/native-scrollback model**: a
fixed top region with a scrollable middle can only exist when the app owns the
whole viewport, which requires the terminal's *alternate screen buffer* and an
app-managed scroll region. The two cannot coexist, so this is a layout-model
decision, not an incremental tweak.

## Decisions

### 1 · A capability-gated, live-switchable layout model

A new `layout` config knob (`"fullscreen"` | `"scrollback"`, default
`"fullscreen"`) selects the model. The **effective** mode is resolved by the
pure `tui/layout-mode.resolveLayoutMode`, which forces `"scrollback"` whenever
the terminal can't support the alternate-screen layout — a non-TTY stdout/stdin
(CI, pipes) or `TERM=dumb`. This is why every existing test, rendered under jsdom
with no TTY, keeps the historic layout untouched.

The mode is live-switchable with **`/layout [fullscreen | scrollback]`** (bare
opens a picker), persisted to `config.json`, and overridable per-run with
`COGNIA_LAYOUT`.

### 2 · Fullscreen runs in the alternate screen buffer

`tui/screen.ts` owns the alternate-screen escapes (`?1049h` / `?1049l`, plus a
clear-and-home on entry). Entry/exit is idempotent at the terminal level, so two
owners can manage it without coordinating:

- **`mount.tsx`** enters *before the first paint* (so the opening frame draws on
  the cleared alt buffer instead of flashing on the normal buffer) and exits in a
  `finally` as a hard-exit safety net.
- **`App`** owns a `useEffect` keyed on the effective `fullscreen` flag, so a live
  `/layout` toggle enters/exits in place, and unmount always restores the
  terminal (and the user's prior scrollback).

Although the enter escape is idempotent, the *clear-and-home* is not: re-issuing
it **after** Ink's first paint wipes that frame, and because the post-measure
re-render is usually identical (content fits → offset stays 0) Ink's diff writes
nothing — the screen stays blank until a resize forces a full repaint. So
`mount.tsx` passes `altScreenPreEntered` to `App`; the App's effect then *skips*
the redundant enter/clear on the initial fullscreen mount (it already happened
before the first paint) and only enters on a live `/layout` toggle.

### 3 · An app-managed scroll viewport

In fullscreen the transcript renders in `live` mode (a plain column, **no
`<Static>`**) inside `ScrollView` — a `flexGrow` box with `overflow: hidden`
whose content is shifted up by a negative top margin (the pager trick).
`measureElement` reports the content + viewport heights after layout; the pure
`scroll-view-state` module turns those into a clamped offset, and `useScroll`
wires it to keys. The view **sticks to the bottom** by default (following new
output) and re-pins automatically on submit / `/clear`.

`PgUp` / `PgDn` page the viewport (conflict-free — the composer ignores
PageUp/PageDown); reaching the bottom re-engages follow mode, so `PgDn` doubles
as "jump to latest." A `↑ N more lines below` hint shows whenever the view is
scrolled up.

**Mouse** behaviour is a deliberate, configurable trade-off (`mouse` config knob,
`"select"` | `"scroll"`, default `"scroll"`; live-toggleable via `/mouse`). The
two modes are mutually exclusive at the terminal level:

- `"scroll"` (default) enables SGR mouse tracking (`screen.ts` writes `?1000h` +
  `?1006h`): the terminal reports the wheel as `ESC[<b;col;row(M|m)`, the pure
  `input/mouse.parseMouseEvent` decodes it, and the App routes a wheel notch to
  `scroll.lineUp` / `lineDown` (3 rows) — so the wheel scrolls the transcript out
  of the box, like any pager. The cost is native selection — only `Shift`+drag
  selects while tracking is on.
- `"select"` leaves the mouse **uncaptured** so native click-drag text selection
  / copy works. To stop the wheel forging `Up`/`Down` arrows (which the composer
  would eat as history navigation), `screen.ts` writes `?1007l` to **disable
  alternate-scroll** — so the wheel is simply inert and `PgUp`/`PgDn` scroll the
  viewport.

In both modes every text field guards its catch-all insert with `isMouseSequence`
so a stray report is never typed as literal `[<…M`. `applyMouseMode` /
`resetMouse` own the escapes alongside the alt-screen lifecycle (and `mount.tsx`
applies the configured mode before the first paint). The wheel handler also
scrolls the `DocumentViewer` pager when in `scroll` mode.

### 4 · The banner becomes a live fixed header

Because the fullscreen banner stays on screen for the whole session (unlike the
scrollback banner, which scrolls away), it carries a live status line —
permission mode (with a `⚠` for `bypassPermissions`), context-window occupancy,
and cumulative session tokens — reusing the existing `format/usage` helpers. The
footer keeps the detailed/activity segments; the scrollback banner is unchanged.

### 5 · Composer affordances

The composer gained a dim empty-state **placeholder** (hidden once typing starts
or a popup opens) and a **mode-aware border** that turns the loud warning color
while `bypassPermissions` is active — so the dangerous mode is unmistakable in
either layout.

## Trade-offs accepted

- **No native scrollback in fullscreen.** Committed history no longer lands in
  the terminal's scrollback, so it isn't retained after exit and mouse-selection
  across scrolled-away content is harder. This is inherent to the alternate
  screen buffer and is the explicit price of a fixed banner. Users who prefer the
  native model switch with `/layout scrollback` (also the automatic fallback on a
  non-TTY).
- **Whole-viewport re-render.** Without `<Static>`, the visible transcript is
  reconciled each frame. Acceptable for the bounded length of an agent session;
  windowing/virtualization can be added later if a session grows pathological.

## Deferred (deliberately)

- **Per-cell virtualization** of the scroll viewport (see trade-offs).

> **Update.** Mouse-wheel scrolling was originally deferred, then implemented by
> capturing the wheel via SGR tracking (`?1000h`). Capturing the mouse, however,
> breaks native click-drag text selection (only `Shift`+drag survives), which
> users hit immediately. The wheel-vs-selection tension is irreducible at the
> terminal level, so it is now a **mode** (`mouse` config / `/mouse`): the default
> `"scroll"` captures the wheel to scroll the transcript (the common expectation
> for an interactive terminal); `"select"` restores native selection and disables
> alternate-scroll (`?1007l`) so the wheel can't corrupt the composer's history
> for users who prefer plain click-drag. See section 3.

## Consequences

The fixed-region layout is the new default on interactive terminals and degrades
transparently to the historic scrollback model everywhere else. New pure modules
(`layout-mode`, `screen`, `scroll-view-state`) and the `useScroll` hook /
`ScrollView` component are fully unit-tested; the reducer gains a `SET_LAYOUT`
action and the command surface a `/layout` command. No sidecar, Rust, or desktop
code is touched.

## 2026-08 follow-up — virtualized viewport and measured chrome

The previously deferred per-cell virtualization is now implemented. A pure
variable-height block index, exact terminal-row counts, two-viewport overscan,
and block-id/intra-row anchoring replace whole-transcript rendering. Append,
resize, and height correction preserve the reader's anchor; `End`/`G` restores
follow-tail. Chrome is budgeted across the 100/60/40-column and 12-row breakpoints.
`COGNIA_TUI_RENDERER=legacy` is the one-release rollback; virtualized is default.

Native-scrollback resize replay is capped at 10,000 rendered rows by default
(`render.terminalResizeReplayMaxRows`; `0` means unlimited). This limits terminal
repaint only: `/transcript`, export, and session storage remain complete.

## 2026-08 correctness follow-up — authoritative viewports and input ownership

Fullscreen overlays now consume the region height measured by Ink/Yoga after the
fixed bottom chrome is allocated. Panel bodies derive content rows from that
viewport, dynamic lists keep their active row visible, the multiline composer
uses its existing row budget, and width-dependent transcript rendering receives
the root's reactive columns. Unicode editing is grapheme-safe and `useCursor`
anchors IME at the painted caret. A single active input provider dispatches by
priority and stops on handled input, preventing modal keys from leaking into the
composer. Jest component tests remain fast, while a child-process probe imports
real Ink/Yoga and the production `TuiViewportFrame`; the PTY harness mounts the
production `App` with a deterministic agent session.
