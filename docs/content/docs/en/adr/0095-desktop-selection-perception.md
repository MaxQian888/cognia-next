---
title: "0095 — Desktop Selection Perception: Observed, Gated, and OCR-Backed"
description: "Selection sensing moves from polling every click to an AXObserver-driven bus with a cheap click fallback, an OCR path for apps with no accessible text, and a permission probe that refuses to read the screen blind."
---

# ADR 0095 — Desktop Selection Perception

- **Status:** Accepted
- **Date:** 2026-07-29
- **Builds on:** ADR-0020 (computer use / input monitoring), ADR-0024 (OCR), ADR-0093 (selection toolbar)
- **Lives in:** `crates/cognia-automation/src/automation/{selection_events.rs,platform/ax/observer.rs,platform/shared/{screen_capture.rs,screenshot.rs}}`, `src-tauri/src/selection_toolbar.rs`

## Context

The selection toolbar (ADR-0093) sensed selections in exactly one way: subscribe to the
process-wide input tap and, on **every** left-button release anywhere on the desktop, spawn a
task that slept 60ms, read the accessibility selection, and — if that came back empty — slept
another 120ms and read again. On macOS the focused-window lookup behind that read forks
`osascript` whenever its 250ms cache misses.

Three things follow, and all three are the same root cause: the feature had no way to know
whether anything had happened.

1. **Cost is paid per click, not per selection.** A plain click cannot produce a selection,
   yet it paid the full price. So did a click in an application the user had explicitly
   disabled — `app_is_disabled` was checked *after* the read, using the source app the read
   itself reported.
2. **Keyboard selection was invisible.** ⇧→ and ⌘A produce no mouse-up, so the toolbar
   simply never appeared for keyboard users.
3. **Apps without accessible text were dead ground.** Images, PDF viewers, Java and Qt
   applications, remote desktops, and Chromium builds that have not been asked to publish
   their web-content tree all return nothing, forever, at full cost.

Meanwhile `subscribe_events` — the obvious mechanism for "tell me when a selection changes" —
returned `UnsupportedPlatform` on macOS, and `pick_at_point` returned the focused *window's*
metadata regardless of the point it was given.

## Decision

### 1. Two layers, arbitrated by the gesture — not by the application

Layer 1 is a cheap gate on the existing input tap: remember the press, classify the release as
`Drag { bounds }`, `MultiClick { count }` or `Ignore`, and pre-filter on a new
`selection_preflight()` (process name, window title, secure-field verdict) that answers from
AX in one round-trip and never forks a process. Layer 2 is a real `AXObserver`.

The two must not both read the same selection. The tempting rule — "does this application
generally post notifications" — was rejected: it needs a pid to compare against, the only pid
available at mouse-up comes from the last notification, so the comparison is true by
construction; and a user moving from a talkative app (Safari) to a silent one (Terminal)
inside the trust window would have their drag routed to a layer that never fires.

The rule is instead **"was *this gesture* observed"**, which is precisely what an armed settle
timer means. A talkative app arms it during the drag, so the release defers and the settle
fires immediately afterwards. A silent app never armed it, so the release reads the selection
itself. No window, no pid, no per-app state.

### 2. Metadata on the bus, text on one gated path

`selection_events` is a fan-out hub shaped like `input_monitor`'s: bounded, drop-on-full, so a
native callback is never blocked by a slow consumer. It carries *only* kind, pid, selected
length and a timestamp.

Putting selected text on it would mean every keystroke in every text field on the desktop
streaming through a process-wide broadcast channel with several subscribers. A consumer that
decides it wants the text still has to go and read it at a moment of its own choosing — so the
body stays on the single, gated `read_text_selection` path, and every character of user text
has one auditable route.

### 3. One observer, re-targeted at the frontmost application

`AXObserverCreate` is per-process. Registering against every running application would mean
hundreds of observers, nearly all silent. Instead one dedicated thread runs a `CFRunLoop` —
the same structure `input_monitor/hook_mac.rs` uses for its `CGEventTap`, deliberately not a
second pattern — and re-targets when the frontmost pid changes.

`CFRunLoop::run_in_mode` makes the poll free: it services callbacks for one interval and
returns, so the loop *is* the timer and no `CFRunLoopTimer` is needed. The frontmost pid comes
from the system-wide element's `AXFocusedApplication`, which is one mach round-trip — not
`NSWorkspace` (a new AppKit dependency in a crate that has none) and not `osascript` (a fork).

Registration is on the *application* element, so one registration covers every text control in
it, and `AXUIElementSetMessagingTimeout(0.25)` ensures one wedged app cannot stall the run
loop for every other. Every failure — sandboxed app, no accessibility server, refused
registration — is logged at debug and leaves that one application to the click path. Nothing
here may turn an uncooperative app into a feature-wide error.

### 4. Keyboard selection settles before it appears

`AXSelectedTextChanged` fires once per keystroke during a ⇧→ run. A 350ms quiet period
collapses the burst; re-arming pushes the deadline *out* rather than firing. An empty
selection dismisses immediately. Selections above 4,000 characters never auto-raise, because
⌘A over a document precedes a delete or a replace, not a translation — the chords still work.

The keys that *build* a selection (arrows, Home/End, Page Up/Down, and `A` while a settle is
pending) are excluded from the "user has moved on" dismissal. Without that exclusion the
keyboard path is broken by construction: the keystroke that arms the toolbar would also
dismiss it.

### 5. OCR is a fallback, and it refuses to read the screen blind

When both accessibility reads come back empty, the drag region is captured and OCR'd — but
only if it was a real drag with room for legible text, in an app that is not disabled or a
credential prompt, with a working OCR backend, **and** with Screen Recording permission
actually granted.

That last gate is the reason this section exists. macOS does not error when the grant is
missing: `CGDisplayCreateImage` and everything on top of it, `xcap` included, succeed and
return the desktop *with every window's contents omitted*. OCR then produces confident,
well-formed text that has nothing to do with the selection — and this feature would offer it
as "your selection", send it to a model, or write it into long-term memory. A wallpaper with
words on it is a perfectly valid image, so there is no detecting this afterwards. We preflight
with `CGPreflightScreenCaptureAccess` and skip silently; we never call
`CGRequestScreenCaptureAccess` implicitly, because it prompts exactly once per application
ever and a denial is permanent.

Region capture needed a second fix. `ScreenshotOpts.region` is monitor-local *physical* pixels
— the right contract for Computer Use, where the model is pointing at an image it was shown.
A drag bounding box is neither: it is global *logical* points. Passing one straight through
crops a rectangle that is doubly wrong on Retina and wrongly positioned on any monitor that is
not at the desktop origin, while still returning an image. `capture_global_region` is
therefore a separate entry point, and `global_rect_to_monitor_pixels` is pure so the
conversion is pinned by unit tests rather than by noticing bad OCR.

OCR text gets its own `SelectionOrigin::Ocr` rather than a sibling boolean: it is a different
trust level and it travels, so downstream consumers get the fact for free.

### 6. Availability is a capability, not a feature flag at the call site

`NativeOcrRegistry::list_ids()` cannot answer "is OCR usable" — `install_platform_backends`
registers a `PlaceholderBackend` under *every* id precisely so the dispatch table stays dense.
`NativeBackend::is_available()` (false for placeholders) and `available_ids()` give the real
answer, so on a default Windows build — where every `ocr-*` feature is opt-in and
`ocr-windows` additionally needs MSIX package identity — the fallback disables itself with no
`cfg` at the call site. Apple Vision is bound unconditionally on macOS, so the fallback is
live there.

### 7. Renderer payloads are untrusted

The classifier that decides whether to show "Open link" runs in the overlay. Rust re-parses
the URL and allowlists http(s), builds the `mailto:` itself from an address that must pass a
shape check (no whitespace, no `?`/`&`/newline, exactly one `@`), and encodes the search query
through `url` against its own engine table. The renderer names an engine; it never supplies a
URL. A UX filter is not a security boundary.

Browser page URLs come from AX (`AXWebArea` → `AXURL`), never AppleScript: `tell application
"Google Chrome" to get URL` triggers the Apple Events TCC prompt *once per target
application*, so a user selecting text in three browsers would face three new permission
dialogs. AX needs only the grant the feature already requires.

## Consequences

- `EventKind::TextSelectionChanged` is opt-in and deliberately absent from the default filter.
  Including it would make every pre-existing subscription — notably the workflow
  desktop-event trigger — start registering a subtree-scoped UIA 20014 handler and paying for
  it. The wire value is mirrored in `lib/automation/types.ts` and the zod `DesktopEventKind`
  in `lib/workflow/nodes/params-schemas.ts`; a miss there makes the trigger reject the kind.
- `capabilities().has_events` is now true on macOS, which also makes the workflow
  desktop-event trigger real there for the first time.
- The subscription must be released explicitly in `selection_toolbar_stop`. The monitor task
  is `abort`ed, so no `Drop`-based async teardown inside it would ever run, and the observer
  thread would otherwise outlive every toggle-off.
- `AxBackend` implements `Drop` for the same reason: the worker rebuilds its backend after a
  panic, and without it each panic would strand another observer thread.
- Windows is compile-unverified for the UIA half — this repo's toolchain has no Windows target
  installed and the environment could not fetch one. The API surface was checked against the
  `uiautomation` 0.25 source signature by signature.
- Linux is unchanged. AT-SPI selection reading was never implemented, and nothing here
  changes that.
