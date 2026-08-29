---
title: "0158 — Artifacts and Canvas: where they live and who may author one"
description: "Artifacts move out of a 5 MB localStorage blob into Dexie; the model gets tools to create one by name; png/pdf export becomes real; and workflows can reach both. Plus the eight modules retired to get there."
---

# ADR 0158 — Artifacts and Canvas: where they live and who may author one

**Status:** Accepted
**Date:** 2026-08-29
**Related:** [ADR-0139](./0139-visual-output-routing), [ADR-0090](./0090-unified-agent-execution), [ADR-0100](./0100-unified-template-platform), [ADR-0127](./0127-chat-transport-batching), [ADR-0138](./0138-chat-reading-area-stability)

## Context

The artifact and canvas subsystem is large — 54 components, 56 more for Canvas,
a 2 400-line Zustand store — and, unusually for this repo, most of it was
already wired. `pnpm audit:unreachable-components` was green, and not one of the
five baselined entries belonged to this area.

The gaps were narrower and less visible than "a dead module".

**The model could not create an artifact.** Eleven tool names were declared in
`types/agent/tool.ts`, and *both* message-conversion paths (`lib/claude/adapter.ts`
and `lib/ai/agent/external/event-to-parts.ts`, with duplicate logic) already knew
how to turn such a call into an `ArtifactPart`. Nothing defined, registered or
executed any of them. Artifacts could only be lifted out of a reply by the
end-of-turn heuristic detector, which by construction cannot know a chart's
`chartType` or an artifact's intended title.

**Two paths were already broken.** `components/chat/message-parts/canvas-inline-part.tsx`
linked at `/canvas/<id>`, a route that never existed — the app is a static export
with no dynamic segments anywhere under `app/`. And React artifact previews were
dead in every shell: React 19 publishes no UMD build, so the `unpkg.com/react@19/umd/…`
script tags 404 and every preview fell through to a 15-second timeout message.

**The storage was lossy by design.** Artifacts, their version history and canvas
documents all shared one `cognia-artifacts` localStorage key. To fit the ~5 MB
ceiling, `partialize` truncated each artifact's content at 100 KB and evicted
everything past the 200 most recent — on every write, silently, and permanently,
because the shortened copy was what the next reload read back.

**png and pdf were advertised and unimplemented.** `ArtifactExportFormat`
declared both; no adapter offered either; and ADR-0139's resident routing prompt
told the model on every send that a chart artifact was "exportable".

## Decision

### 1. Dexie owns artifacts and canvas documents

Schema v206 adds `artifacts` and `artifactVersions`. Persist v6 stops writing
artifacts to localStorage; v7 stops writing canvas documents. What is left in
the blob is the dock's preferences: workspace filters, the per-session tab strip,
and which artifact each conversation was parked on.

`lib/artifacts/dexie-bridge.ts` and `lib/canvas/dexie-bridge.ts` are write-through
mirrors that seed the store on boot. Both follow two rules the account lifecycle
forces, and both pin them with tests:

1. **Never write to a database the mirror was not built against.** Locking an
   account calls `clearAccountDatabaseSelection()` *before* `clearAccountLocalState()`,
   so a live subscription observes an empty store pointed at a different database.
   Since deletes are derived from "in the mirror, absent from memory", that write
   would empty the other database. The db name is captured at hydration and
   re-checked on every flush; `CanvasBridgeProvider` restarts both bridges on
   `accountRevision` instead.
2. **A failed hydration disables the mirror entirely.** A partial read makes
   memory an unknown subset of the table, and syncing it would delete the rest.
   The canvas bridge had its `.catch` *before* its `.then`, which swallowed the
   failure and started the subscriptions anyway.

The migration is crash-safe rather than best-effort. The store rehydrates the
legacy blob into memory and `partialize` stops writing it back, so the
localStorage copy can vanish before the Dexie write lands — leaving exactly one
copy, in memory. `lib/artifacts/localstorage-migration.ts` parks a copy under a
separate key first and clears it only once the write succeeded, so an interrupted
run replays on the next boot.

Making Dexie the only copy exposed what the canvas mirror had been dropping:
`docToRow` never carried `sourceArtifactId`, `returnContext`, `authoringOrigin`
or `aiWorkbench`. Invisible while localStorage was authoritative; a broken
"return to the artifact this came from" the moment it stopped being.

### 2. The agent tool surface rides the existing relay, not a second MCP server

```
model → sidecar cognia-plugin-tools  (unchanged)
      → plugin_tool_exec frame        (unchanged)
      → handlePluginToolExec          (new branch)
      → runArtifactBuiltinTool        (new)  → useArtifactStore
      → plugin_tool_response
      → tool_result → ArtifactPart
```

The host-routed builtin-tool relay already carries six tool families across both
dispatch paths and is reused by the CLI. A second MCP server would have bought a
second registration surface, a second permission keying, and a second place for
a tool to go missing.

**Eight tools are published**, not eleven. `artifact_search` folds into
`artifact_read`'s optional `query` — one optional field beats a whole schema the
model pays for on every turn. `artifact_render` is the dock's job. `artifact_export`
is withheld because a model writing to the user's disk is a consent question, and
the button is one square from the user's eye.

**The part is emitted from `tool_result`, never `tool_use`.** This was the root
cause of the "content cleared" placeholder: `tool_use` arrives *before* the row
exists, so a part built from it can only point at an id that does not resolve.
`lib/artifacts/tool-part.ts` is now the single converter both paths call, replacing
the duplicated pair.

**The union is a contract, not a wish list.** `types/agent/tool.ts` lists exactly
the names `buildArtifactManifestEntries()` and `buildCanvasManifestEntries()`
publish, and a test asserts the equality. This is why the batch needs no dormancy
annotation: a name without an implementation is a red test, not a comment nobody
reads.

Consent follows the surface. `artifact_delete` is `ask`; create, update, read and
open are `allow`, because the card is on screen, every write keeps a version, and
`artifact_update` passes through the same review gate a heuristic revision does.
Every name is registered **twice** — bare and `mcp__cognia-plugin-tools__`-prefixed
— because the Anthropic path sees one and the AI-SDK path the other.

The manifest is gated on the same predicate that gates ADR-0139's routing prompt,
hoisted so the two cannot drift: a resident prompt must never advertise a surface
whose tools are absent. IM-bound sessions get neither.

### 3. png and pdf export are implemented, and there is one download path

`lib/artifacts/export/` renders every format. SVG goes through `Image` + canvas;
`html` through an off-screen **non-sandboxed** same-origin iframe, because
html2canvas cannot read into the sandboxed preview frame — the content is
`DOMPurify`-sanitised first, which is what makes dropping the sandbox acceptable.
Renderer-profile types (`chart`, `mermaid`, `math`) rasterise from their mounted
node via a preview registry, and say `ArtifactPreviewNotMountedError` when there
is none rather than returning a blank image.

`react` offers `raw` only: an off-screen capture of unexecuted JSX is a blank
rectangle, and pretending otherwise would be a worse failure than refusing.

The three download paths that disagreed — the panel's, its "download as", and the
chat card's `text/plain` blob that named a chart `chart.chart` — now all call
`exportArtifact`.

### 4. Workflows reach both, with three deliberate omissions

`action.artifact.{create,update,get,export}` and `action.canvas.{create,get}`.
Writes go through `runArtifactBuiltinTool` so the review gate and the version bump
have one implementation. Reads deliberately do **not**: that runner truncates at
8 KB because its consumer is a context window, and a flow's consumer is code.

`export` returns the bytes instead of calling `saveExport`, which opens a native
save dialog and would park an unattended run on a modal nobody is there to answer.

Absent on purpose: `delete` (removing a user's saved output unattended is a
consent problem), `canvas.update` (a Canvas document is an editor buffer whose
authoritative copy is `editorRef.current.getValue()`, so a background write either
stages a diff nobody accepts or overwrites what someone is typing), and
`canvas.open` (revealing a panel means nothing in a headless run).

### 5. Eight modules retired rather than wired

Each had a better implementation already running; wiring them would have created
a second mechanism.

| Retired | Why not wire it |
| --- | --- |
| `lib/canvas/plugins/` | A second canvas plugin model competing with `PluginExtensionSlot canvas.toolbar` + `lib/plugin/api/canvas-api.ts` |
| `use-chunk-loader` + `chunked-document-store` + `large-file-optimizer` | A JS window on top of Monaco's own virtualization, fighting it |
| `lib/sandbox/web/` | Its documented caller never existed; `lib/native/code-execution-strategy.ts` runs JS/TS/JSX/HTML/CSS in every shell already |
| `use-canvas-documents` | A thin sorting façade over the store |
| `use-canvas-auto-save` | Holds `localContent`, which fights the panel's authoritative `editorRef.getValue()`. Its one better behaviour — cancelling the pending tick on document switch — was moved into the panel |
| `version-diff-view.tsx` | A 7-line re-export shim |
| `ArtifactListCompact` | Every real surface is covered by `ArtifactTabStrip` / the dock / `ArtifactList` |

The two survivors were wired instead: `getCanvasPerformanceProfile` now drives
deliberate large-document degradation (and is the first writer of
`CanvasEditorContext.performanceMode`), and `ContextAnalyzer` gives Canvas
suggestions a scope block — after being made to delegate to the already-wired
`symbolParser` instead of carrying a second regex parser.

## Consequences

- A long artifact keeps its full text and an old one is no longer evicted. The
  `cognia-artifacts` blob drops to kilobytes.
- Moving the caret through a large Canvas document no longer re-serialises every
  canvas document the user has.
- The model can name what it is creating, so a chart artifact carries its
  `chartType` — something the heuristic detector cannot produce.
- Backups carry the two new tables, and the per-domain "Artifacts" export reads
  Dexie. A package written before v206, whose artifacts are inside the
  localStorage snapshot, still imports.
- Because manifest changes cross the IPC boundary, a green Jest run does not
  prove the shell works; `tauri-smoke` is the gate that does.

## Resolved — the srcdoc CSP measurement

**Answered.** Measured on macOS / WKWebView against a Tauri shell built WITHOUT
`cfg(dev)`, carrying `src-tauri/tauri.conf.json`'s `csp` verbatim and serving its
dist through the asset protocol at `tauri://localhost`. The enforced policy was
read back from a real `securitypolicyviolation` event's `originalPolicy`, so this
is what the shell delivers, not what the config claims.

| Question | Answer |
| --- | --- |
| Does an `about:srcdoc` child inherit the shell CSP? | **Yes** — verbatim, including the five script hashes tauri injects |
| Does `'self'` match inside a sandboxed, opaque-origin child? | **Yes** — a same-origin `<script src>` loads while inline is refused |
| Does a `blob:` document escape it? | **No** — sandboxed or not, it inherits too |

The two policies **intersect**. That is what makes the shape shipped today fatal:
a frame whose meta says `script-src 'unsafe-inline'` under an inherited
`script-src 'self' 'wasm-unsafe-eval' blob:` can run *nothing at all* — inline is
struck out by the inherited policy, and the same-origin URL by its own. Measured
directly: that frame executed zero of its three scripts.

So the second architecture applies, and the shell CSP is untouched. Two things
still run in such a frame, and the preview is built out of exactly those two:

- a **same-origin `<script src>`** — `/artifact-runtime/react-runtime.js` (React
  19 + `react-dom/client`, production build) and
  `/artifact-runtime/artifact-shell.js` (the in-frame bootstrap);
- a **`blob:` script** — how the artifact's own code arrives, after the host has
  transformed it. `blob:` is in both policies, so it needs no new permission.

JSX is compiled in the **host**, in a Worker (`worker-src 'self' blob:` already
allowed), so `@babel/standalone` never enters the frame and `'unsafe-eval'` is
needed nowhere. The frame keeps one `ReactDOM.createRoot` for its lifetime, so an
edit re-renders in place instead of re-navigating the iframe.

Verified end to end inside that shell, driving the production modules: a React
artifact — including one written as ESM, which the old shell could not parse —
renders with **zero external requests**, and a second version renders into the
same live frame with **zero iframe navigations**.

**Interactive HTML artifacts** (`artifacts.interactiveHtml`, default off, and
then authorised per artifact) follow from the same measurement rather than from
`srcdoc` + `'unsafe-inline'`, which would have run nothing here.
`lib/artifacts/interactive-html.ts` lifts every executable byte out of the
markup — inline `<script>` bodies in document order, and `on*` attributes
rewritten into `addEventListener` calls whose bodies are still *source*, never a
string handed to `new Function`. They come back as ordered `blob:` scripts. A
third-party `<script src>` is dropped and reported, because the frame's policy
names no external origin. The frame drops `allow-same-origin`, so the artifact
runs with an opaque origin: no host, no cookies, no storage, no network.

### The other seven srcdoc features

All seven use the same shape the measurement condemns — `sandbox="allow-scripts"`
+ `srcdoc` + a meta CSP whose `script-src` is `'unsafe-inline'`. In the packaged
desktop shell **none of their scripts can run**: the MCP Apps sandbox, plugin
webviews, the VS Code extension panel, `plan-html-view`, the share page's
`chat-animated`, `code-execution-strategy`, and `task-resources-panel`. Each has
the same fix available — serve the frame's code from `'self'` or a `blob:`
script — and each is a separate change, tracked on its own ticket. Nothing in
this batch touches them.

Still unfixed: `scripts/gates/check-network-egress.mjs` cannot see a
`<script src="https://…">` inside a template literal — it only scans `fetch`,
`new WebSocket` and `new EventSource`. This change removes the last such site in
the app, but the blind spot remains.
