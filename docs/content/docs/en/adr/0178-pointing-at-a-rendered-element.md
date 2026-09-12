---
title: "0178 — Pointing at a rendered element"
description: "The artifact preview becomes something you can point at, one picker serves three render transports without weakening a sandbox, and the browser's review queue becomes a queue both surfaces share."
---

# ADR 0178 — Pointing at a rendered element

**Status:** Accepted
**Date:** 2026-09-12
**Related:** [ADR-0158](./0158-artifacts-and-canvas), [ADR-0139](./0139-visual-output-routing), [ADR-0055](./0055-agent-browser-loop), [ADR-0083](./0083-context-workbench), [ADR-0155](./0155-plugin-author-boundary)

## Context

The artifacts dock was, by every structural measure, finished. One shell
(ADR-0083), sixteen registered panels, `audit:unreachable-components` green.
Adding another panel would have been noise.

What it could not do was let you point at anything.

Selection in artifacts was text-only — `selection-comment-button.tsx` reading
`window.getSelection()` — and it rendered only in the `code`, `review` and
`split` view modes. In `preview` there was no selection affordance at all, and
structurally there could not be one: every rendered artifact lives in an
iframe, so the parent's `getSelection()` sees nothing inside it. The artifacts
where "change *this* element" is the obvious request — `html`, `react`, `svg`,
`chart` — were exactly the ones with no way to make it.

One icon away, the embedded browser had the entire vocabulary already:
`BrowserSelection` with selector, DOM path, computed styles, accessibility,
React component name/stack/props and inspector source hints; four detail
levels; a prompt writer; a durable annotation queue with intent, severity,
status and threads. All of it `isTauri()`-gated, and none of it reachable from
an artifact.

## Decision

### 1. One picker, parameterised by the Document it runs in

An artifact renders in one of three ways, and they differ in whether the app
can reach the rendered DOM at all:

| transport | types | reachable? |
| --- | --- | --- |
| `renderer` / `jupyter` | code, document, mermaid, chart, math | yes — live React in the host tree |
| `iframe`, `allow-same-origin` | html (static), svg | yes — the parent already *writes* this document |
| `iframe`, `allow-scripts` | react, interactive html | no — opaque origin (ADR-0158) |

The first two are the same problem. The third is that problem on the far side
of a `postMessage` boundary. So `lib/artifacts/runtime/element-pick.ts` takes
the target `Document` as an argument and is bundled into **both** the app and
the in-frame shell.

**No sandbox was weakened to achieve this.** The `allow-same-origin` frames
were already parent-writable, and the `allow-scripts` frames already had a
shell speaking `postMessage`; the picker is one more message on a channel that
existed for `capture-snapshot`.

Two consequences that are easy to get wrong and are pinned by tests:

- The module never touches the ambient `window`. In the same-origin iframe case
  the target document's view is the *frame's* window, so reading
  `window.innerWidth` would describe the wrong viewport and `getComputedStyle`
  would be called on a foreign node. Everything goes through `doc.defaultView`.
- The picker takes a **root**. Renderer-transport artifacts draw in the app's
  own tree, so an unscoped picker offers the dock, the rail and the
  conversation as pick targets — and, because it swallows clicks in the capture
  phase, makes the surrounding application unusable while armed.

### 2. The preview owns the transport branch; nothing else may know about it

`ArtifactPreview` registers a controller with
`lib/artifacts/element-pick-registry.ts`, and the toolbar just says "arm". This
is the shape `frame-capture-registry.ts` already uses for exports, for the same
reason: only the preview knows how it drew what it drew.

The registry **publishes** changes rather than being read once. The preview
registers while it mounts, which is after the toolbar has rendered and decided
its toggle was disabled; a plain `Map` read would have left the button greyed
out over a perfectly pickable preview with nothing to ever re-render it.

### 3. A pick has two destinations, and they are genuinely two

- A plain click stages an `ArtifactSelectionRef` in the composer. That kind is
  documented as *the only kind eligible to be the edit target*: it is what lets
  the reply come back as a revision proposal diffed against this artifact.
- ⌘/Ctrl-click sends it immediately, through the browser surface's existing
  delivery path.

An earlier draft routed picks **only** into the annotation queue. A
fresh-context review killed it: an element that becomes only an annotation can
never become a revision proposal, which forfeits the single most obvious thing
a user wants from picking an element in an artifact. The composer chip is the
ephemeral path (consumed by the next message, can be widened, refreshed,
promoted, removed); the annotation is the durable one (intent, severity,
outcome, thread). Collapsing them would have lost one.

`ArtifactSelectionRef.element` is additive: `range` stays the diff anchor, and
is resolved from the element — verbatim markup, then an id or class anchor when
the renderer normalised attributes, then the whole artifact when a rendered
node has no textual counterpart at all (a chart drawn from data).

### 4. The review queue is shared, and scoped

Artifact annotations live in the **same table** as the browser's, render
through the same components, and are formatted by the same writer. A review
note about an element is the same thing whichever surface the element was on.

Making that safe required fixing a defect that predates this work.
`listActionableBrowserAnnotations` and `listPendingBrowserAnnotations` scanned
the whole table and filtered on `sessionId` **alone**. Harmless while the
browser was the only writer; with a second one, an artifact annotation would
have appeared in the browser pane's queue, opened its inspection rail by itself
— which issues an `embedSetBounds` and physically resizes the native webview —
and then been batch-sent to the model under a `# Browser annotation batch`
heading with a screenshot of the browser attached. Both readers now take a
scope filter.

**No schema version was bumped.** The scope is resolved in memory, exactly
where these readers already scanned, so no index moved. That is not laziness:
adding a `scope` index would have dropped every existing row out of it for the
full 30 days of `BROWSER_ANNOTATION_RETENTION_MS`, and `CURRENT_SCHEMA`'s
`.upgrade()` callback re-writes every `messages` row on any bump.

`target` is normalised at the write boundary, so a stored row is always
explicit about what it is about, while the field stays optional on the type —
`BrowserAnnotationRow` and `saveAnnotation` are published to plugin authors
(ADR-0155/0156), and a plugin writing the older shape still compiles. A row
with no `target` is a web annotation: not a guess, but the only thing this
table could hold at the time.

### 5. The surface names itself

Three places hard-coded "in-app browser" / "Browser annotation batch". An
artifact element announced under that banner tells the model to go looking for
a web page that was never involved. `ElementSelectionCore.originLabel` travels
with the selection — it has to, because a queued annotation is formatted long
after it was taken, by a batch writer that has no idea which surface produced
which row.

`BrowserSelection` now extends `ElementSelectionCore`, additively: the DOM does
not become a different thing because of what is hosting it, and the published
field set is byte-identical.

## What was deliberately not done

- **The browser's inspection rail was not extracted.** It closes over roughly
  twenty-six bindings, several of them browser-only — the native capture rect,
  the `embedSetBounds` animation clock, the Adjust controls' page URL. A shared
  component taking all of those as props is a worse abstraction than two hosts.
  The intent/severity selects and the queue list moved; the rail did not.
- **`lib/browser/overlay.injected.js` was not reused.** It is a 3 155-line ES5
  IIFE that Rust injects into a native webview and that patches global timers
  on install. `cssSelector` and `domPath` are re-implemented in TypeScript, and
  a parity suite evaluates the real overlay file in jsdom and asserts both
  agree across nine DOM shapes — so the two cannot drift silently.
- **The `browserAnnotations` table was not renamed.** The noun is wrong and the
  cost of fixing it is a break in a published plugin surface. The module says
  so at the top instead.

## Consequences

- Every rendered artifact surface can be pointed at, including sandboxed React
  artifacts, with no sandbox relaxed and no new transport.
- The bundle freshness sentinel now records esbuild's real `metafile.inputs`
  instead of one hard-coded path. Its predecessor had already shipped one
  silent regression ("the capture-snapshot handler was written, tested, and
  silently not shipped") and kept the shape of that bug: the first second
  module would have reintroduced it.
- `capture-snapshot` now serialises a clone with the picker's chrome stripped.
  An export taken while select mode was armed would otherwise have baked the
  highlight into the PNG.
- The 19 annotation translation leaves left the `browser` namespace, which
  keeps strings like "Browser Adjust". Dynamic keys are invisible to
  `lint:i18n`, so a catalogue-coverage test pins every intent, severity and
  status in both locales.
