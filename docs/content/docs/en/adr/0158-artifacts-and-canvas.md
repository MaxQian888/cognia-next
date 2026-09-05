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

`react` offered `raw` only for the same reason, since an off-screen capture of
unexecuted JSX is a blank rectangle. It now offers `png` and `pdf` too, by
asking the live frame for a snapshot of what it drew (see the amendment below).

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


## Amendment (2026-09-03) — React artifacts export as PNG

The Decision above gave `react` `raw` only, and the comment in
`runtime-adapters.ts` blamed the missing offline runtime. That reason expired
when the runtime landed in this same ADR, and the real blocker was never
stated: a React artifact's frame is `sandbox="allow-scripts"` with no
`allow-same-origin`, so the parent cannot read into it, and re-rendering the
SOURCE off-screen captures unexecuted JSX.

Rasterising inside the frame is not the answer either, and this is worth
recording because it is the obvious thing to try. html2canvas clones the
document into a child iframe and reads it back, but an opaque-origin document
cannot read even its own `about:blank` child. Measured in a browser against a
frame built exactly like the preview: `contentDocument` comes back `null`.
Canvas and `toDataURL` do work in there, but nothing can get the DOM into a
canvas in the first place.

So the frame serialises rather than rasterises. A new `capture-snapshot`
message asks it for a static HTML document of what it drew, and the parent
renders that in the same-origin capture frame it already uses for `html`
artifacts. The snapshot's scripts are stripped by the existing sanitizer, which
is correct here: the snapshot is post-execution DOM, so they have already run.

Consequences worth knowing:

- **`png`/`pdf` for `react` need a MOUNTED preview**, unlike every other type.
  The exporter raises `ArtifactPreviewNotMountedError` when there is none,
  rather than emitting a blank image.
- **A frame that failed to render refuses to be captured.** It would otherwise
  serialise its empty body and produce a blank PNG with no explanation.
- **The runtime build sentinel now hashes the shell's source.** It previously
  watched only the react/babel versions and the OUTPUT hashes, so editing
  `artifact-shell-entry.ts` left the committed bundle stale while the build
  reported "already fresh". The capture handler was written, tested and
  silently not shipped until that was fixed.

## Amendment (2026-09-05), completing Canvas on the existing architecture

Seven changes, all in place. No V2, no parallel Canvas, no second store, no
replacement route. What follows is what each one found, because in most cases
the surface already existed and the finding was that nothing was behind it.

### A document belongs to one workspace

Every Canvas *list* read the raw `canvasDocuments` map. Switching workspace left
the previous workspace's documents in the rail, and `canvas_read` /
`canvas_update` scoped by `sessionId` only, so a model or plugin running in one
workspace could read and rewrite a document owned by another.

`getCanvasDocumentsForWorkspace` and `getCanvasDocumentForWorkspace` are the two
scoped reads every surface shares. The by-id one answers `null` for "not yours"
as well as "not there", so the difference cannot enumerate another workspace.
Documents with no `projectId` are grandfathered, matching
`applyArtifactWorkspaceFilters`, because the v86 backfill stamps them on the
next boot.

### Closing is not deleting

Canvas had no "open vs all" state, so the tab strip's X called
`deleteCanvasDocument`: closing a tab destroyed the document, its versions and
its comments, with no prompt and no undo.

`useCanvasLayoutStore.openDocIds` is that state. It is a per-user layout
preference rather than a property of the document, because two people sharing a
document do not share a tab strip. Deleting keeps its meaning, gains a prompt
that says what goes with the document, and releases the pin, the tab and the
comment threads. Owners outside the artifact store let go through
`lib/canvas/document-disposal.ts`, a registry in the shape of
`registerProjectBucketPurger`, so a persisted and near-universally imported
store does not drag the comment store's localStorage migration into every
consumer.

### One AI path

There were two. `useCanvasActions` built its own prompt and gated it with
`hasNoLeakingPii`. `lib/plugin/api/canvas-api.ts` called `executeCanvasAction`,
which built a *different* prompt (attachments, per-action temperature) and gated
nothing. A plugin got richer prompts and no redaction check.

Both call `runCanvasAction` / `streamCanvasAction`, with the gate inside rather
than at each call site. Three actions were also unobservable: `review` and
`explain` returned text into a `useState` in the editor pane that nothing
rendered, and `run` asked a model to *imagine* executing the code next to a
panel that actually runs it. `review` produces anchored suggestions, `explain`
renders in the AI panel, `run` delegates to the execution panel.

`CanvasAIWorkbenchState` had six fields and no writer at all. Every field now
has a control and a writer, minus `pendingReview`, which was a second copy of
`pendingReviews[documentId]` and is deleted rather than kept in sync.
Suggestions come back through `generateObject` against a zod schema, replacing
an `indexOf("{")`-to-`lastIndexOf("}")` slice followed by hand-written `typeof`
filters that silently dropped what they did not recognise.

### The hunks you accept are the hunks you read

The review UI rendered `computeDiff`, an LCS diff. The hunks came from a second,
hand-written diff with a five-line lookahead. On a block move the two disagree
about which lines changed, so an accepted hunk was applied at line numbers the
reader never saw. There is one diff now, and a round-trip test that fails if
they diverge again.

Staleness was an `isStale` flag `updateCanvasDocument` had to remember to set.
It is derived from a content fingerprint (`lib/canvas/content-hash.ts`), which
matters because accepted hunks are applied BY LINE NUMBER: a proposal applied
against moved content corrupts the document with no error. That fingerprint is
also what makes persisting a proposal safe, so an open review survives a reload
instead of being discarded to guarantee it could not be stale.

### A new document can be a real document

Every entry point ran the same unlabelled call: an empty Markdown document
titled "Untitled". A subsystem for editing documents could not open one from a
file. The dialog asks for a name, a language, a starter body, or a file.

Import reuses `@cognia/document`, the parser chat attachments and the knowledge
base already go through, and answers the two Canvas-specific questions it does
not: which editor language this becomes, and what was lost getting here. Text
and code arrive byte for byte. A PDF or Office file becomes editable Markdown
and says so before anything is created.

Starters are deliberately neither the unified template platform (ADR-0100),
which is for installable, shareable, parameterised templates, nor the editor
snippet registry, which would leave `${1:name}` tab stops in the buffer.

### Stop stops the interpreter

Cancelling a Python run aborted an `AbortController` the Rust side never saw.
The UI detached and the child kept running to its 30s timeout. A run carries an
id, `canvas_cancel_python` kills it, and the in-flight call returns the output
the program produced before it died.

The registry holds a **cancel signal, not the child**: `wait_with_output`
consumes the handle, so parking the child would mean taking it back out to wait
on it, and a cancel arriving during the wait would find nothing. Pipes are
drained on their own tasks, so a program writing more than the pipe buffer
cannot deadlock the run that cancellation exists for.

Settings, Canvas, Execution had seven controls and no reader. Three are read
now. Four were **removed rather than disabled**: `autoExecute`,
`preserveVariables`, `sandboxMode` and `pythonRuntime`. The last two read as
security and capability controls and did nothing at all, while confinement
actually lives in `AppSettings.canvasCodeSandboxEnabled` (Settings, Sandbox).
Whether a language can run is asked before the click, from the host.

### A real CRDT, and a link that carries only ids

The old CRDT was positional with **no transform**. An operation was an absolute
character index spliced into the receiver's already-mutated string, so two
people inserting at index 10 both applied at raw index 10 and the documents
diverged while `version` incremented on both sides. Its only conflict machinery
was a causal gate that DROPPED what it could not order, with no buffer and no
retry, so a reordered delivery was lost permanently.

**Yjs is a new dependency, and the only one taken.** There is no CRDT in this
repo to reuse in JS or in Rust, and hand-writing one is how the implementation
above happened. Everything else was reused: the LCS diff from
`lib/artifacts/diff.ts`, `@cognia/document` for import, and CodeMirror 6 for the
editor rather than adding a second editor framework.

`deserializeState` is gone. It parsed attacker-supplied JSON and installed
whatever session, participants and permissions it described, reachable from a
share link and from any inbound frame typed `"sync"`. State arrives as opaque
bytes and can only merge into a session the client is already in.

The share link carried the session, its owner, its participants, its permission
flags, the content and the whole operation log, plus a `?server=` URL the join
page wrote into persisted settings with `enabled: true` and no validation of
scheme or host. It carries three identifiers now. The two halves also disagreed
about encoding, so no link this app ever produced decoded, and the page reported
success without joining anything.

## Amendment, 2026-09-05: the plane learns to hold a Canvas document

The amendment above recorded that `cognia-collab-server` served no Canvas route,
so the transport was unreachable and failed closed. It serves them now, and the
client reaches them.

### The server does not link Yjs, and does not need to

Every payload in `canvas_document_updates` and `canvas_documents.snapshot` is an
opaque update. The server orders them, hands them back in order, refuses a
duplicate operation id, and never decodes one. That is sound because Yjs updates
commute: a joiner that applies the snapshot and then each later update arrives
where everyone else is, whatever order the writes landed in.

Compaction is a client act for the same reason. A peer holding the whole
document posts `Y.encodeStateAsUpdate` naming the sequence it covers, and the
rows at or below it become redundant. Only a maintainer may, because a snapshot
from a stale peer would retire edits it never saw, and the store refuses a
`coversSequence` that walks the marker backwards or past what exists.

`yrs` therefore stays out of the build. The only new dependency on either side
is the one the client already needed.

### Membership is the workspace's

There is no per-document member table. A Canvas document is not invited to
individually the way a shared chat session is, so a second membership system
next to `workspace_memberships` would only be somewhere for the two to drift
apart. `CanvasAction` maps onto the ladder that already exists: viewer reads,
member edits and comments, maintainer deletes, compacts and manages sharing. An
org owner or admin traverses in as a maintainer, which `resolve_workspace_access`
decides rather than anything in the Canvas modules.

A caller outside the workspace is answered 404, not 403. Confirming that an id
names a real document somewhere they cannot see is the leak.

### Authorization runs per frame

A ticket proves the bearer could read 30 seconds ago. A socket lives hours. Each
inbound write re-resolves the caller's workspace role, one indexed lookup beside
a transaction that already inserts and updates, so removing somebody from a
workspace stops their typing at the next keystroke rather than at their next
reconnect.

### What made the offline queue possible

`(document_id, operation_id)` is unique. A drain interrupted halfway leaves a
client unsure which writes landed, and the honest recovery is to send them all
again: the second attempt returns the update already stored rather than
recording the edit twice. The same property is what lets `POST .../updates`
serve both the live path and the catch-up path.

### The client half

The provider no longer holds a URL or a token. It takes a factory and calls it
again for every retry, which answers three separate problems: a bare
`WebSocket` in the renderer misses the desktop proxy settings, a single-use
ticket cannot be replayed on reconnect, and a caller-supplied URL is exactly how
the old join page pointed the transport at an arbitrary host.

Canvas calls ride `CollabClient`, sharing its grant cache, its
one-retry-on-401 and its transport. Share links now carry the real organisation
from the sign-in binding, replacing the literal `"personal"` that no server
could have honoured.

Two behaviour changes are worth naming. A failed connection reports `error`
rather than `disconnected`, so a refused socket is distinguishable from never
having tried. And a reconnect rejoins as the actual participant instead of one
named `"Reconnecting..."` in grey, which is what peers used to see in the
roster.

Off by default behind `COLLAB_CANVAS_ENABLED`.

### What is deliberately still open

- **Editor bindings.** Monaco, CodeMirror and the comment anchors are not yet
  bound to the shared Yjs document, and comments still carry their anchor as an
  opaque string the server stores without interpreting. The column is there and
  the type is Yjs-relative, but nothing computes one yet.
- **The offline replay queue is in memory.** Frames a down socket refuses are
  queued and flushed on reconnect, which covers a blip but not a reload. A
  durable queue is an additive Dexie table and is not in this cut.
- **Rich Markdown editing** is not shipped. The plan named Milkdown. The reuse
  path is CodeMirror 6 decorations over `@codemirror/lang-markdown`, which is
  already a dependency and, unlike a ProseMirror round-trip, cannot lose an
  unsupported construct because the buffer never stops being Markdown.
- **The collaboration settings block (8 fields) is still inert.** The transport
  exists now, so these are wiring rather than blocked work: presence settings
  should drive cursor and avatar rendering, and the reconnect fields should
  reach the provider's own budget instead of its defaults.
