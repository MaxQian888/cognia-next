---
title: "0093 — Selection Toolbar: Content-Hugging Overlay and Six-Action Contract"
description: "The system-wide text-selection toolbar's native window is sized by the renderer instead of hard-coded, dismissals carry a reason, and six actions collapse into three feedback modes across the overlay/main-window boundary."
---

# ADR 0093 — Selection Toolbar: Content-Hugging Overlay and Six-Action Contract

- **Status:** Accepted
- **Date:** 2026-07-29
- **Builds on:** ADR-0020 (computer use / input monitoring), ADR-0058 (desktop pet overlay windows), ADR-0069 (long-term memory), ADR-0075 (voice / TTS)
- **Lives in:** `src-tauri/src/selection_toolbar.rs`, `components/selection-toolbar/`, `lib/tauri/selection-toolbar.ts`, `lib/tts/speak-selection.ts`, `components/providers/initializers/selection-toolbar-initializer.tsx`

## Context

The system-wide selection toolbar (select text in any application → a floating capsule offers
actions) shipped with a native window whose size was a constant:

```rust
const TOOLBAR_WIDTH:  f64 = 360.0;
const TOOLBAR_HEIGHT: f64 =  44.0;
const TOOLBAR_MENU_HEIGHT: f64 = 280.0;
```

Nothing about that box was derived from its contents, and three visible defects followed from
the single cause:

1. **The drop shadow was amputated.** The capsule is `h-9` inside an `h-11` container, leaving 4px
   of margin. `shadow-xl` blurs far past that, the window is created `shadow(false)`, and
   `html[data-selection-toolbar]` forces `overflow: hidden` — so the shadow was cut on every side.
2. **The surplus width was a dead zone.** The window was always 360px but the capsule was narrower.
   `point_inside_toolbar` hit-tested the *window* rect, so a click on the transparent margin was
   treated as "inside the toolbar": it neither pressed a button nor dismissed. Tauri cannot make
   part of a window click-through, so widening the canvas would only have made this worse.
3. **Opening the language menu teleported the capsule.** `selection_toolbar_set_interactive(true)`
   resized the window to `TOOLBAR_MENU_HEIGHT` *and* re-anchored it for that height. Because the
   toolbar is anchored above the selection (`y = anchor.y - height - margin`), growing the height
   moves the window's top edge up — and the capsule rendered at the top of the window, so it jumped
   roughly 236px up the screen.

Two further gaps were structural rather than visual:

- **No enter or exit animation existed, and none could.** Appearing was `window.show()` after two
  rAFs; leaving was `window.hide()`. Both are instantaneous at the OS level, so the renderer never
  had a frame to animate in.
- **The idle timer could not be cancelled.** A single `sleep(IDLE_DISMISS_MS)` per candidate meant
  the toolbar vanished after 10s even with the pointer resting on it.

The subsystem also had no ADR and no row in the Subsystem Map, while acquiring a cross-window
protocol and six actions.

## Decision

### 1. The renderer measures; Rust follows

A new `selection_toolbar_resize(width, height, capsule) -> { placement }` command replaces the
constants, mirroring `island_resize` (`src-tauri/src/fleet/island_window.rs`). The renderer
measures in a `useLayoutEffect` keyed on a content signature and applies the island's grow-now /
shrink-after-220ms rule so a collapsing height never outruns its CSS transition.

`width`/`height` describe the whole window box — the capsule plus `SELECTION_SHADOW_PAD` (20px)
of transparent margin on each side, which is what gives the shadow and the enter/exit scale
somewhere to paint.

### 2. Hit-testing uses the capsule, not the window

`resize` also carries the capsule's rect *inside* the window, in logical pixels; Rust scales it by
the window's scale factor and hit-tests that. The shadow margin is therefore transparent to both
the eye and the mouse: a click there dismisses, as it does anywhere else outside the pill.

### 3. Placement is returned, not assumed

`clamp_toolbar_position` always chose above-or-below (it flips below when the anchor hugs the top of
the work area) but never told the renderer. It now returns `ToolbarPlacement`, and `resize` returns
it too — the answer can flip once the real measured height is known. The renderer uses it twice:

- as the capsule's `transform-origin`, so the enter animation grows *out of* the selection;
- to pick which edge the content is anchored to. Rust pins the window edge nearest the selection,
  so content is bottom-aligned when placing above and top-aligned when placing below. That is what
  keeps the capsule still while the window grows for the language panel — the defect in §Context 3.

For the same reason the language picker is rendered inline rather than in a Radix portal: a
portalled `position: fixed` menu sits outside the measured shell, so the window would never grow to
contain it.

That swap has an accessibility cost that has to be paid back explicitly. `DropdownMenu` supplied
roving focus, arrow keys, Home/End and Escape for free; a plain `<ul role="listbox">` supplies none
of it, and the toolbar *does* take focus while the panel is open, so the keyboard genuinely reaches
it. The panel therefore implements roving tabindex, arrow/Home/End movement with wrap-around, and
opens with focus on the current target.

Escape is layered rather than global. Rust's key monitor used to dismiss on Escape unconditionally,
which would have made the panel's own Escape unreachable. It now tracks whether a focus-taking
sub-panel is open (`interactive`) and, when one is, forwards `selection://escape` to the renderer
instead of dismissing — so the first Escape closes the panel and the second closes the toolbar, the
same layering every other popover in the app has.

### 4. Dismissals carry a reason

`dismiss(app, inner, reason)` takes `Interrupted | Idle | Completed`.

- `Interrupted` (click elsewhere, keystroke, scroll, feature stop) hides **synchronously**. The user
  is already doing something else; an always-on-top pill fading over what they just clicked reads as
  lag, not polish.
- `Idle` and `Completed` emit first and hide after `EXIT_ANIMATION_MS` (160ms), guarded by the
  existing `generation` counter so a delayed hide cannot swallow a fresh candidate.

### 5. A keep-alive replaces the one-shot idle timer

`keep_alive: AtomicBool` plus a 500ms watchdog tick. The renderer raises it on pointer enter, while
the language panel is open, and for the whole of any pending action or playback. This matters more
now that the capsule is icon-first: the user *must* hover to read a label.

### 6. Six actions, three feedback modes

`SELECTION_ACTIONS` (`components/selection-toolbar/selection-toolbar-actions.ts`) is the renderer's
single enumeration; `SelectionToolbarAction` and `SELECTION_ACTION_SHORTCUTS` are its Rust half.

| Mode | Actions | Focus main window | Toolbar |
| --- | --- | --- | --- |
| `local` | copy | — | ✓ for 420ms, then leaves |
| `handoff` | explain, translate, ask, convertUnit | **yes** | leaves at once |
| `await` | remember, speak | no | stays, driven by a result |
| `launch` | openLink, composeEmail, searchWeb | no — raises the *browser* | leaves at once |

`launch` (added with the contextual actions, ADR-0095) is why `holds_toolbar()` is an
explicit `match` rather than `!focuses_main()`. That identity held only while every action
either raised the main window or completed in place; `launch` does neither — it raises a
third application — and an always-on-top pill left floating beside a browser that is already
in front reads as exactly the lag §4 exists to avoid.

`SelectionStagePayload` gained `focusMain`, and `bring_window_to_front` is now conditional on it.
Raising the whole application to read a sentence aloud or stash a note defeats the point of both.

The `await` mode exists because `storeExternalMemory` *returns* `{ok: false, reason: "pii_blocked"}`
rather than throwing (`lib/memory/api/store-memory.ts`). Dismissing optimistically would make a
blocked write a silent no-op whenever the main window is in the tray.

### 7. Speech plays in the main window

The toolbar renders the transport, but `ttsOrchestrator.speak` runs in the main window and progress
is pushed back over `selection://speech`. Two reasons: overlay windows are deliberately
least-privilege presentation shells (`lib/pet/window-role.ts`; `/selection-toolbar` is in
`PET_WINDOW_ROUTE_PREFIXES`, so it mounts only the minimal shell), and the orchestrator owns an
`<Audio>` element per webview — speaking from the overlay would open a second player that talks over
a chat message already being read.

### 8. Global shortcuts, bound with the feature

`alt+shift+1..6` map to the six actions via the existing `ShortcutRegistry`, bound in
`selection_toolbar_start` and released in `selection_toolbar_stop` — deliberately *not* in
`seed_builtins`, which would squat six chords for users who never enable the feature. A chord the
user has already re-bound is left alone. Dispatch is a **notification** (`selection://shortcut`), not
a second execution path: the renderer owns the chosen translation target, the phase machine and the
exit animation, and forking those in Rust would guarantee drift.

The passive `CGEventTapOptions::ListenOnly` monitor cannot consume keystrokes, so reacting to raw
keys would have typed the digit into the user's document. Real global shortcuts are the only safe
mechanism here.

## Consequences

- Every size change costs one IPC round-trip. Hovering is exempt: the window is pinned once to the
  widest reachable hover state, measured from an off-screen ghost row per action, so label expansion
  is pure layout animation.
- The renderer is authoritative for window geometry. A renderer that fails to measure leaves the
  window at its `MIN_*` placeholder — but it is created `visible(false)` and revealed only after the
  first successful resize, so the placeholder is never on screen. That reveal ordering also supplies
  the resize nudge a `transparent(true)` window needs on Windows to avoid painting black
  (see `lib/pet/reveal.ts`).
- `MemorySourceChannel` gained `"selection"`. It is a provenance tag only — nothing branches on it.
- Linux is unchanged: AX/UIA selection reading was never implemented there.
- **Per-action ordering is fixed; visibility is not.** Superseded by ADR-0095. The six
  actions above keep their relative order and their chords, but four contextual actions
  (open link, email, search, convert) join them when a pure classifier matches the
  selection, and one user-facing switch turns that off. Visible actions are capped at six,
  and the overflow evicts a *generic* action from the tail — never a matched contextual one,
  and never `copy`. Because contextual actions render at the tail too, the row length is
  constant and no generic button ever moves sideways.
- **`§8`'s chord independence is now load-bearing.** The chords resolve through the whole
  action table, never the visible list, so `⌥⇧6` still reads aloud when `speak` has been
  evicted. Contextual actions deliberately get no chord: one that only works when the
  selection happens to be a URL cannot become a habit, and it would have to be taken from a
  stable action to exist.
