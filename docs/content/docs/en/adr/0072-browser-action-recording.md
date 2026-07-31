---
title: ADR-0072 — Browser action recording
description: "Record real human interaction in the embedded /browser preview into a canonical RecordedFlow, then replay it through the existing ADR-0055 engine or export it as raw JSON, a Playwright spec, or agent-context markdown. The flow is the single source of truth and every export is a pure serializer over it. A navigation destroys the page's JS context, so the buffer is mirrored to sessionStorage, polled by the renderer every 400ms, and re-armed on browser://loaded with a resume that never discards what survived. Passwords are flagged, never captured: exports emit process.env and replay takes a secrets map that fails loudly on a missing key. Steps store a durable CSS selector and replay resolves selector → ref so ADR-0055's act-by-ref discipline holds. Flows persist to Dexie v110, local-only."
---

# ADR-0072 — Browser action recording

**Status**: Accepted (2026-07-16)
**Authors**: Max Qian + Claude

## Context

ADR-0055 gave the agent a `snapshot → act-by-ref → re-snapshot` loop over the
embedded `/browser` pane, so the model can drive a local dev preview in the same
pane the human watches. The reverse direction never existed. A person who
reproduced a bug, walked a login, or stepped through a checkout produced
**nothing reusable**: to hand that flow to the agent they retyped it as prose
from memory, and to turn it into a regression test they wrote the Playwright
spec by hand. Both transcriptions are lossy in the same place — the selector of
the element actually clicked — which is the one detail neither a person nor a
model can reconstruct after the fact.

Everything needed to observe the flow was already in the pane. The injected
overlay (`lib/browser/overlay.injected.js`) is installed in the previewed page
and already hooks `console`, `fetch`/XHR, `window.open`, and history; it already
mints stable `data-cognia-ref` handles and computes `cssSelector` / `roleOf` /
`accessibleName` for the human click-to-select flow. The engine can already act
by ref. The missing piece was a capture path and a data model to put between
them.

## Decision

Record real user interaction in the previewed page as a canonical
**`RecordedFlow`**, review it in the pane, then either replay it through the
**existing** ADR-0055 engine or export it in the format the user picks.

### One data model, three exporters

`RecordedFlow` (`lib/browser/recording/protocol.ts`) is the single source of
truth: the capture path produces it, the replay path consumes it, and every
user-selectable artifact is a pure `flow → string` serializer in
`exporters.ts` — raw JSON (re-import and hand-editing), a Playwright spec, and
agent-context markdown for the chat composer.

This is the decision that makes "pick your output format" cheap. The
alternative — a recorder per target — is three capture paths that drift, three
places to fix a selector bug, and a new recorder for every new format. Here a
fourth format is one function. `protocol.ts` and `exporters.ts` deliberately
import neither Tauri nor DOM, so they stay in the fast `node` jest project.

The Playwright exporter prefers `page.getByRole(role, { name })` and falls back
to a CSS locator only when the element had no mapped role or accessible name.
That is the entire reason `role` and `name` are captured at record time
alongside the selector: a role locator survives markup churn, and a generated
spec full of brittle CSS paths is a spec nobody keeps.

### A navigation destroys the page's JS context

This is the constraint the whole capture path is shaped around. A real
navigation replaces the document, and **the click that caused it — a login
submit — is usually the most important step in the flow**. Losing it is not a
degraded recording; it is a useless one.

Three layers, each covering the previous one's gap:

1. **The page mirrors every step to `sessionStorage`** (`persistRecord`) as it
   buffers. sessionStorage survives a same-origin navigation, so the re-run of
   the IIFE in the fresh document calls `restoreRecord`, sees the recording
   flag, and restores the buffer — including the click that navigated.
2. **The renderer polls `embedDrainRecord`** every 400 ms (`DEFAULT_POLL_MS`)
   and accumulates into one flow across documents. A drain that throws is
   swallowed: the pane can be mid-navigation with no live JS context, and the
   page keeps buffering, so the next poll collects it.
3. **The renderer re-arms on `browser://loaded`** — the existing event, not a
   new one. This covers the cross-origin case, where sessionStorage does **not**
   carry over and the fresh document is disarmed with an empty buffer.

### `resumeRecord` is deliberately distinct from `startRecord`

`startRecord` begins a fresh take and **clears the buffer**. `resumeRecord`
re-arms and keeps it. The distinction is load-bearing, and only visible if you
trace both navigation kinds through layer 3 above:

- **Same-origin**: `restoreRecord` already re-armed and restored the buffer, so
  the resume is a no-op. Re-arming with `startRecord` here would **wipe the
  click that caused the navigation** — the exact step layer 1 existed to save.
- **Cross-origin**: sessionStorage did not carry over, the buffer is legitimately
  empty, and this is what re-arms the page at all.

One `browser://loaded` handler serves both, so it must use the verb that is
correct in both. `noteLoaded()` therefore **drains first, then resumes**: on the
same-origin path those restored steps must be collected before anything else
touches the page's state. A test pins the call order
(`expect(order).toEqual(["drain", "resume"])`), because the drain-then-resume
sequence is invisible at the type level and a plausible-looking reorder silently
loses the login click.

### Passwords are never captured

An `input[type=password]` records `{ value: "", secret: true }` — the flag, never
the value. This is not conservatism about a hypothetical: flows **persist to
Dexie** and the agent export is **written into a model prompt**, so capturing the
value would put a credential at rest *and* on the wire in one step. The repo
already treats that as the line you do not cross (`packages/redact`'s
`hasNoLeakingPii` gates every outbound LLM/embed call); a recorder that quietly
serialized passwords into IndexedDB would be a hole underneath that gate rather
than a feature.

The consequence is that a recorded login is not self-sufficient, and each surface
resolves the secret in its own idiom:

- **Playwright export** emits `process.env.<secretKey> ?? ""` — the spec stays
  credential-free and lands in `tests/e2e/` safely.
- **Agent export** says the value was not recorded and to ask the user. It does
  not emit an env var, because the model has no environment to read.
- **Replay** takes a `secrets` map and **fails the step loudly** on a missing key
  rather than typing `""` into a credential field. A silent empty fill would
  surface later as a mysterious "invalid password" and send the user debugging
  the wrong thing.

`secretKey()` lives in `protocol.ts` and is shared by the exporter and the
replayer, so the env-var name in a generated spec and the lookup key the UI asks
the user to fill are the same string by construction. Deriving it twice would
let the spec read a variable the UI never mentioned.

### Refs die with their generation, so steps carry a selector

ADR-0055 mints `ref` handles per snapshot `generation`; they are meaningless once
the document reloads — which is precisely what happens in the middle of any
realistic flow. So a step cannot record a ref, and stores a durable CSS selector
instead.

That could have become an act-by-selector back door, quietly retiring ADR-0055's
act-by-ref discipline. It does not. A new page helper **`refFor(selector)`**
mints (or returns) a `data-cognia-ref` for the matching element, and replay goes
`selector → ref → engine.act(ref, …)`. Acting still flows through `refMap`; the
selector is only how replay *finds* the node. `refFor` mints rather than only
looks up because the human may have clicked something the snapshot would not
surface as interactive.

Replay adds **no new engine**. `replayer.ts` drives the existing
`EmbeddedEngine`, settles the document after a click or key that may have
navigated, and stops at the first failure — a flow is a sequence, so continuing
past a broken step reports cascading failures that all trace to the first one.
The agent export closes the loop by telling the model the same thing: re-snapshot
and act by ref; the selectors are there to help it find the right node.

### Deliberately not recorded

Each omission is a step that would be noise or would always fail:

| Not recorded | Why |
| --- | --- |
| File inputs | Synthetic events are `isTrusted:false`, so the picker rejects them — the ADR-0055 injected-JS ceiling. The step could never replay, so recording it manufactures a guaranteed failure. |
| Plain keystrokes | `change` carries the settled value as one `fill`. Recording each keystroke would bury the flow in noise and replay less faithfully — the page only ever saw the settled value. |
| Clicks on `select` / `option` | The element's `change` already covers it. The click would replay as "open the dropdown" and then fight the select step. |
| Checkbox / radio `change` | The click step already carries the state transition. |
| Shift + letter | Capitalisation, which `change` captures in the value — not a chord. A modifier plus a single character (`ctrl+a`) is. |

**Navigation steps are minted by the renderer, not the page.** The renderer
already tracks `browser://navigated`; adding a second detector in the page would
mean two sources disagreeing about the same event. `appendStep` collapses the
duplicates that do arrive (a click that navigates reports through both the
history hook and the load event; a redirect chain reports every hop) and
supersedes successive edits of the same field.

### Dexie v110, local-only

```
browserRecordings: "&id, baseUrl, updatedAt, [baseUrl+updatedAt]"
```

The row **is** the domain type: `RecordedFlow` already carries the `id`, the
`baseUrl` and `updatedAt` the indexes need, and the steps, so there is no second
row shape to keep in sync. The compound `[baseUrl+updatedAt]` serves the pane's
only list query — flows for the origin currently loaded, newest first.

Steps are **nested, not a join table**: a flow is only ever read or written
whole, so a join buys nothing and costs a transaction per read.

The table is **not registered in `lib/sync`**. A flow scripts one machine's dev
server; syncing it would push `localhost` URLs off-device for no benefit to any
other device. Local-only is the correct default here, not a deferred feature.

## Architecture

```
human clicks in the pane ──► overlay.injected.js  [capture-phase passive listeners]
                                │  buffers steps + mirrors to sessionStorage
                                ▼
                          browser_embed_{start,resume,stop,drain}_record   [Rust]
                                │  eval_embed_with_result (strings only)
                                ▼
   browser://navigated ──► FlowRecorder (poll 400ms, accumulate)  ──► RecordedFlow
   browser://loaded ─────►   drain → resume                              │
                                                                          ├─► exporters.ts ─► json / playwright / agent
                                                                          ├─► Dexie v110 browserRecordings
                                                                          └─► replayFlow ─► EmbeddedEngine (ADR-0055)
                                                                                  selector → refFor → act(ref)
```

- `lib/browser/recording/protocol.ts` — `RecordedFlow`, `RecordedStep`
  (`navigate` / `click` / `fill` / `select` / `press_key` / `wait_for`),
  `appendStep`, `supersedes`, `secretKey`, `requiredSecrets`, `resolveStepUrl`.
  No Tauri, no DOM.
- `lib/browser/recording/exporters.ts` — `toJson`, `toPlaywrightSpec`,
  `toAgentContext`, dispatched by `exportFlow(flow, format)` + `exportFilename`.
- `lib/browser/recording/recorder.ts` — `FlowRecorder`: the poll loop,
  `noteNavigation`, `noteLoaded` (drain→resume), assertions, step removal.
- `lib/browser/recording/replayer.ts` — `replayFlow` over `BrowserEngine`; the
  `secrets` map; abort between steps.
- `lib/browser/overlay.injected.js` — the "Action recording (ADR-0072)" block
  (`startRecord` / `resumeRecord` / `stopRecord` / `drainRecord` /
  `restoreRecord`, capture-phase `click` / `change` / `keydown` listeners) plus
  `refFor(selector)`, exposed as `window.__cognia*Record` / `__cogniaRefFor`.
- `src-tauri/src/browser/embedded.rs` — `browser_embed_ref_for`,
  `browser_embed_{start,resume,stop,drain}_record`. All return **strings**:
  `eval_with_callback` only marshals strings reliably across WKWebView/WebView2.
- `hooks/browser/use-flow-recorder.ts` — React binding; owns the two pane events
  the page cannot see for itself; `safeUnlisten` for the StrictMode race; cancels
  a take on unmount so the page is never left armed with nobody draining it.
- `components/browser/browser-recorder-panel.tsx` — record → review →
  replay/export, three states derived rather than stored.
- `lib/db/browser-recordings.ts` — CRUD over the v110 table.

Assertions (`wait_for`) are **never auto-captured**; a person adds them from the
step list. Without them a recording is a script — with them it is a test, and
only a human knows what the flow was supposed to prove.

## Honest limits

- **The eval bridge cannot be covered by jest or cargo.** Everything above the
  bridge is unit-tested (protocol, exporters, recorder, replayer, hook, panel,
  Dexie CRUD), and the overlay's pure helpers are tested under jsdom. But
  `eval_with_callback` against a live WKWebView/WebView2 is exercised by neither
  runner. A `pnpm tauri dev` smoke of one record → replay loop is the manual
  gate. **It has not been performed as of this writing.** This is the same
  ceiling ADR-0055 named for its snapshot→click→snapshot loop.
- **Bounded at 500 steps, keeping the head.** `MAX_RECORD_STEPS` stops pushing
  rather than ring-buffering. A ring would silently *behead* the recording, and
  the opening steps are what define the flow — a take that long is already
  pathological.
- **Everything inherits ADR-0055's Phase-1 limits**: cross-origin iframes are
  invisible, synthetic events are `isTrusted:false`, closed shadow DOM is
  unreachable. A flow that depends on those was never replayable.
- **A recorded selector is as durable as the markup.** The role/name capture is
  what makes the Playwright export resilient; the JSON and replay paths still
  anchor on CSS and will drift with a refactor.

## Consequences

- A human walking the pane now produces a first-class artifact: a repro becomes
  a Playwright spec, or agent context, or a saved flow, without retyping it.
  This is the missing return path of the ADR-0055 loop.
- Replay reuses the ADR-0055 engine and its act-by-ref discipline, so recording
  added no second way to drive the page — `refFor` is a resolver, not a back
  door.
- A recorded login is deliberately not self-sufficient: it needs its secret
  supplied at replay or export time. That friction is the point.
- Flows never leave the device, and never contain a credential.
- A fourth export format costs one pure function.
