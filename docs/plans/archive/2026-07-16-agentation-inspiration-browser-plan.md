# Agentation-inspired in-app browser enrichment — implementation plan

**Date:** 2026-07-16
**Status:** plan (no code changed). Hand to implementing agents phase by phase.
**Source study:** [benjitaylor/agentation](https://github.com/benjitaylor/agentation) v3.0.2 (PolyForm Shield 1.0.0 — see §Licensing)
**Our subsystem:** `lib/browser/`, `components/browser/`, `src-tauri/src/browser/` — ADR-0055 (agent loop), ADR-0072 (recording)

---

## How this document was produced

1. Cloned agentation and read it end to end (npm package + MCP server + skills).
2. Mapped our own browser subsystem with a thorough read-only audit (capability inventory with `file:line`, presence **and** absence claims).
3. Kept only the deltas that are **genuinely absent on our side and applicable to our architecture**. Everything rejected is recorded in the appendix with the reason, so nobody re-proposes it.

**Headline finding:** agentation is a **different product shape**, not a competitor. It is an npm package a developer installs into their _own_ React app so a human can annotate and copy markdown for _any_ agent — out-of-process and agent-agnostic, which is the only reason it needs MCP + HTTP + SSE + SQLite. We are in-process: our agent is already there, and our chat pipeline _is_ the transport. Roughly half of agentation's repo therefore has **zero** borrow value for us. The overlap is exactly one path: _annotate an element → hand it to the agent_.

**Second finding, and the one that changes this plan:** the "sentinel URL payload cap" is **not** the binding constraint on multi-select. See §Key architectural finding below. This collapses Phase 6 from transport surgery into "follow the template `embedSnapshot` already established."

**Third finding, worth stating because it removes a whole class of aspiration:** **agentation does not do live style editing either.** Its "design mode" drags a _ghost_ and reports an `originalRect → currentRect` delta for the agent to apply to source. That is philosophically identical to our `resolutionDirective` model (`lib/browser/protocol.ts`). Nobody in this space has solved live-editing; they solved _describing the intended delta precisely_. Phase 8 must not be scoped as live editing.

---

## Key architectural finding (read before Phase 6 or 7)

The received wisdom is that our page→app channel is the cancelled sentinel navigation (`lib/browser/overlay.injected.js:9-14`, `SENTINEL = "https://cognia.invalid/__cognia_select?data="` at ~~`:25`) and that its URL length caps our payload — hence the existing `MAX_OUTER_HTML = 4000`, `MAX_PROPS_KEYS = 10`, `MAX_PROPS_TOTAL = 500` truncations (~~`:26-38`).

**That is only half true, and the wrong half.** The sentinel is the **push** channel — for unsolicited page→app events. We already have a **pull** channel that carries far larger payloads:

- `browserClient.embedSnapshot()` (`lib/browser/client.ts`) pulls an entire accessibility-tree snapshot — **bounded at 2000 nodes, frame depth 8** — as a JSON string through `browser_embed_snapshot` → `eval_with_callback`.
- `embedDrainRecord()`, `embedReadConsole()`, `embedReadNetwork()` do the same for bulk buffers.
- `FlowRecorder.poll()` (`lib/browser/recording/recorder.ts`) polls `embedDrainRecord` every 400ms and tolerates a dead JS context by letting the page keep buffering to `sessionStorage`.

So: **the recorder already solved this exact problem.** The pattern is _sentinel for signal, `eval_with_callback` for bulk_. Phase 6 does not invent chunking — it adopts an in-repo template. This also retires an existing latent risk: today a single verbose selection already pushes toward the URL cap.

---

## Non-goals — do not build these

| Rejected                                                                     | Why                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP server / HTTP server / SSE / SQLite / tenant-store (`mcp/**`, ~4100 LOC) | Solves out-of-process + agent-agnostic delivery. We are in-process. Also: an HTTP listener cannot live in `app/api/` (static export) — it would have to be Tauri axum, for no gain.                                                                                                                                                          |
| `package/src/utils/source-location.ts` (`_debugSource` fiber walk)           | **A trap. Do not port.** Their own file documents React 19 breaking it and ships a `react-19-changed` reason code. Our `readSourceHint` reads `data-inspector-relative-path/-line/-column` (react-dev-inspector convention) and is React-19-safe. We already dodged this; do not walk back into it.                                          |
| Their React fiber detection                                                  | Ours (`componentInfo`, touching only `.type` / `.memoizedProps` / `.return`) is already the safer implementation.                                                                                                                                                                                                                            |
| Zero-dependency / bundle-size discipline                                     | Their constraint (public npm package). We inject a script; not our problem.                                                                                                                                                                                                                                                                  |
| Live style editing / palette-swapping in the page                            | **Agentation doesn't do this either.** See headline finding #3.                                                                                                                                                                                                                                                                              |
| Their `self-driving` skill's coordinate-clicking workarounds                 | Pure workaround debt: they must fire `mouse move`/`down`/`up` at raw coordinates because their overlay intercepts pointer events and `click @ref` punches through, plus a layer of eval-quoting hacks. **We own the embed** — Phase 5 gives the agent a direct tool and none of this applies. Borrow the _idea_, not one line of the method. |

---

## Phase dependency graph

```
Phase 1 (spatial CSS)  ─┐
                        ├─► Phase 3 (detail levels)   [both touch protocol.ts — 1 before 3]
Phase 2 (freeze)       ─┘

Phase 4 (annotation lifecycle) ──► Phase 5 (agent self-critique)

Phase 6 (signal-then-pull transport) ──► Phase 7 (multi/area/text select) ──► Phase 8 (design mode)
                                                                    Phase 4 ──┘
```

- **Parallelizable now:** 1, 2, 4, 6 (four agents, no file overlap).
- **Serialized:** 1→3 (both edit `protocol.ts`), 6→7→8, 4→5.
- Phases 1–3 are pure additive and carry no architectural risk. Phases 6–8 are the expensive half.

---

## Cross-cutting rules for every implementing agent

These are non-negotiable and repo-specific. Violating any one of them wastes the phase.

1. **`lib/browser/overlay.injected.js` is strictly ES5.** Verified: zero `const`/`let`/arrow functions in the file today. It is `include_str!`'d verbatim by `src-tauri/src/browser/overlay.rs` into Tauri's `initialization_script`, must stay dependency-free and self-contained, and also runs under jsdom in `overlay.injected.test.ts`. Use `var` and `function`. No TS, no transpile step.
2. **Every `eval_with_callback` helper returns a _string_ and wraps its body in try/catch, returning error-as-value.** `eval_with_callback` swallows exceptions on Windows (ADR-0072:216-218). Follow the existing envelope shape (`{ok, error, ...}` — see `embedSnapshot` in `lib/browser/client.ts`).
3. **Exclude our own chrome** from any scan/freeze/capture via the existing `data-cognia-chrome` attribute (agentation's equivalent is `data-feedback-toolbar`).
4. **i18n is split-source.** Edit `i18n/messages/en/browser.json` and `i18n/messages/zh-CN/browser.json`, then run `pnpm i18n:build`. **Do not edit `i18n/messages/en.json`** — that is the _built artifact_ and your change will be overwritten. (Any audit or doc citing `i18n/messages/en.json:2009` is pointing at the build output.) Then `pnpm lint:i18n`.
5. **The injected script cannot reach next-intl.** Any user-facing string drawn _in the page_ must be pushed in from React, following the `embedSetPanelLabels` → `__cogniaSetPanelLabels` precedent (`lib/browser/client.ts`).
6. **Co-located tests are mandatory** (Hard Rule 3): `xxx.test.ts(x)` next to source, ≥90% lines/branches/functions. Read the `jest-gotchas` skill **before** writing any test. Rust gets in-file `#[cfg(test)]`.
7. **Changeset required** for every user-facing phase (Hard Rule 6): `pnpm changeset`, package `cognia-next`.
8. **Line numbers in this doc will drift.** The working tree is shared with other agent sessions. Re-grep every anchor before editing; never trust a line number blind.
9. **New Tauri command ⇒ register it** in `generate_handler!` (`src-tauri/src/lib.rs`) _and_ add the capability/ACL entry. Unregistered commands are this repo's #1 recurrent defect and fail only at runtime as a rejected promise.
10. **Dexie bumps** (Phase 4): use the `dexie-migration` skill. Current max is `version(110)` (`lib/db/schema.ts:2481`, `browserRecordings`). Next core-table version is **111**. (`nextSchemaVersion` is for _plugin_ tables only — do not use it here.)

---

# Phase 1 — Spatial CSS translation

> **Highest value per line of code in this plan.** Do this first.

**Goal:** stop handing the model raw pixels. Hand it pixels _plus the arithmetic that turns them into CSS_.

**Borrowed from:** `package/src/components/design-mode/spatial.ts` (`getPageLayout`, `getElementCSSContext`, `formatCSSPosition`) and `package/src/components/design-mode/output.ts` (`formatReferenceFrame`, `formatParentContext`).

**Gap (verified):** `getComputedStyle` appears **exactly once** in our entire browser subsystem — `lib/browser/overlay.injected.js:676`, and only to decide `isVisible` for snapshots. We extract a bounding box and nothing that makes it actionable. `formatSelectionComment` (`lib/browser/protocol.ts`) emits Selector / Path / Component / Source / Props / Text / Page / HTML — no layout context at all.

**What agentation emits that we don't:**

```
### Reference Frame
- Viewport: `1440×900px`
- Content area: `1200px` wide, left edge at `x=220`, right at `x=1420` (`main > div`)
- Pixel → CSS translation:
  - **Horizontal position in container**: `element.x - 220` → use as `margin-left` or `left`
  - **Width as % of container**: `element.width / 1200 × 100` → use as `width: X%`
  - **Vertical gap between elements**: `nextElement.y - (prevElement.y + prevElement.height)` → use as `margin-top` or `gap`
  - **Centered**: if `|element.centerX - 820| < 20px` → use `margin-inline: auto`
- Parent: `flex`, flex-direction: `column`, gap: `24px` (`main > div`)
```

### Design

**`lib/browser/overlay.injected.js`** — collect (ES5), inside `buildPayload`:

- `parentLayout`: from the parent's computed style — `{ display, flexDirection?, gridTemplateColumns?, gap?, selector }`. Only emit the keys that are meaningful for that `display` (no `flexDirection` on a grid).
- `contentArea`: port their `getPageLayout` heuristic — locate the dominant content container (`main`, else the widest stable child of `body`), emit `{ selector, left, right, width, centerX }`.
- `viewport`: `{ width: innerWidth, height: innerHeight }`.

**`lib/browser/protocol.ts`** — extend `BrowserSelection` with the three optional fields above (optional, so a non-matching page degrades exactly like `componentName` already does), and emit a Reference Frame block + per-element CSS line in `formatSelectionComment`.

### Traps

- **Payload budget.** This rides the sentinel today (Phase 6 has not landed yet). Keep the whole addition **under ~250 chars**: cap the selector strings, round every number to an integer, and emit only meaningful keys. Do not add computed styles wholesale — that is what blows the URL.
- **`contentArea` can legitimately be absent** (no distinct container). Agentation handles this with a viewport-relative fallback formula set — port that branch too, don't just skip the block.
- Reuse our existing selector generator; do not port theirs (`generateSelector` in `section-detection.ts`) — ours is already `cssSelector` in the overlay.

### Tests

- `lib/browser/overlay.injected.test.ts` — jsdom: flex parent, grid parent, no-parent-layout, `main`-present and `main`-absent content area, viewport math.
- `lib/browser/protocol.test.ts` — Reference Frame rendering, the no-`contentArea` fallback branch, and that the block is omitted when the fields are absent.

### Verification

`pnpm test -- lib/browser/protocol.test.ts lib/browser/overlay.injected.test.ts`, then drive it for real: `pnpm tauri dev`, open the pane against a flex/grid dev page, select an element, and read the composed chat message. Do not claim done from unit tests alone (Hard Rule / WORKFLOW stage 6).

**i18n:** none (output is a model-facing prompt, not UI). **Changeset:** patch.

---

# Phase 2 — Freeze animations before capture

> Fixes a **real existing defect**, not just a missing feature.

**Goal:** stop capturing torn mid-animation frames.

**Borrowed from:** `package/src/utils/freeze-animations.ts`.

**Gap (verified):** we have no freeze of any kind — grepping `animation-play-state|animationPlayState|getAnimations|pauseAnimations|video\.pause` across the subsystem returns zero hits. And our capture is **worse-positioned than agentation's**: `browser_embed_capture` (`src-tauri/src/browser/embedded.rs:~649`) reuses the automation pipeline's `capture_primary`, i.e. it grabs **composited pixels off the display**. On any animated page, screenshots are non-deterministic today.

**Three capture entry points, all needing this:** camera button (`components/browser/browser-preview-pane.tsx:~326`), auto-attach on comment send (`hooks/browser/use-selection-to-chat.ts:~52`), agent `browser_screenshot` (`lib/browser/agent-engine.ts:~245`).

### Design

**`lib/browser/overlay.injected.js`** — `freeze()` / `unfreeze()` in ES5:

- **CSS injection:** `animation-play-state: paused !important; transition: none !important` on `*`, `*::before`, `*::after`, excluding `[data-cognia-chrome]` and its descendants.
- **WAAPI:** `document.getAnimations().forEach(...)` — **only pause `playState === "running"`**, and store the paused set for restore. Porting note: this is the single most valuable detail in their file. Pausing a _finished_ animation makes it **restart** on `play()`, which visibly breaks entrance animations. Wrap in try/catch — `getAnimations` is not universally available.
- **Video:** pause only videos that were actually playing; restore only those on unfreeze.
- **Timers:** patch `setTimeout` / `setInterval` / `requestAnimationFrame` — queue-and-replay for `setTimeout`/rAF, skip-while-frozen for `setInterval`. Needed even for a short capture window: a rAF-driven JS animation would otherwise advance between freeze and grab. On unfreeze, **re-check the frozen flag before replaying** each queued callback (freeze may have re-entered) — agentation gets this right; copy the re-queue branch.

**New Tauri command:** `browser_embed_set_frozen(on: bool)` → `eval` → `__cogniaSetFrozen(on)`. Register in `generate_handler!` + capability list. Add `embedSetFrozen` to `lib/browser/client.ts`.

**Capture sequence** at all three call sites: `freeze()` → **wait for paint** → capture → `unfreeze()`.

### Traps — read these, they are the whole risk of this phase

- **⚠️ A stuck freeze bricks the user's dev page.** If capture throws or the renderer dies between freeze and unfreeze, the page stays frozen forever with patched timers — indistinguishable from "the dev server hung." **The page must self-heal: arm a watchdog inside `__cogniaSetFrozen(true)` that auto-unfreezes after ~3s** using the _saved original_ `setTimeout`. Never rely on the renderer to call unfreeze. Pin this with a test.
- **⚠️ Freeze → capture needs a paint wait.** `capture_primary` grabs composited pixels off the display. Injecting the pause CSS does not mean the compositor has _presented_ the paused frame; grabbing immediately can capture the pre-freeze frame and silently defeat the whole phase. Wait for a real paint (double-rAF via the **original**, unpatched rAF, plus a small settle) before the Rust call. Verify empirically on a fast CSS animation — this is not something a unit test can prove.
- **Our overlay runs at document-start via `initialization_script`.** Timer patching therefore affects the previewed dev page globally, from the first tick. Keep the patch installed-but-inert (a `frozen` flag check) rather than installing on demand, matching how the file already guards with `__cogniaOverlayInstalled`.
- **Our own chrome must never freeze** — the 【详情】 panel repositions on scroll/resize via rAF and would jam.
- **Do not port their module-level `window.__agentation_freeze` HMR-survival state.** That exists because their module re-executes under HMR. Our script has `__cogniaOverlayInstalled` idempotency already; reuse it.

### Tests

- `lib/browser/overlay.injected.test.ts` — jsdom: freeze injects/removes CSS; only `running` WAAPI animations pause and restore; only playing videos pause; `setInterval` skips while frozen; queued `setTimeout`/rAF replay on unfreeze; **re-freeze during replay re-queues**; **watchdog auto-unfreezes**; chrome is excluded.
- Rust: `#[cfg(test)]` for the command's arg marshalling.

### Verification

`pnpm tauri dev` against a page with a CSS animation + a rAF loop + an autoplaying video. Capture 5 times; assert the images are **identical**. That is the acceptance criterion — unit tests cannot establish it.

**i18n:** none. **Changeset:** patch (bugfix framing: "deterministic screenshots of animated pages").

---

# Phase 3 — Output detail levels

**Goal:** let the user trade prompt tokens against forensic detail. **Do this after Phase 1** (both edit `protocol.ts`).

**Borrowed from:** `package/src/utils/generate-output.ts` (`OutputDetailLevel`, `generateOutput`).

**Gap:** `formatSelectionComment` has exactly one fixed format.

### Design

Level ladder — `compact | standard | detailed | forensic`:

| Level                | Contents                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `compact`            | one line: element + source + comment. No Reference Frame.                                        |
| `standard` (default) | today's output + Phase 1 Reference Frame.                                                        |
| `detailed`           | + classes, bounding box, nearby text.                                                            |
| `forensic`           | + full DOM path, computed styles, accessibility, environment (viewport / URL / DPR / timestamp). |

- `formatSelectionComment(sel, comment, level = "standard")` — default keeps every existing caller compiling and behaviour-identical.
- Setting lives on the browser pane toolbar; persist with the pane's existing settings.
- Their `OUTPUT_TO_REACT_MODE` map (level → how much React info) is a good idea worth keeping: `compact: off`, `standard: filtered`, `detailed: smart`, `forensic: all`.

### Traps

- **`forensic` implies computed styles, which the sentinel cannot carry.** Either land Phase 6 first, or gate `forensic` behind Phase 6 and ship the other three now. **Recommended: ship 3 levels now, add `forensic` in Phase 6's wake.** Do not silently truncate forensic output to fit the URL — that produces a level that lies about what it contains.
- Do not port their `Annotation`-shaped signature; ours formats a `BrowserSelection`.

### Tests

`lib/browser/protocol.test.ts` — one case per level; assert `standard` is byte-identical to the pre-change output (a regression pin); assert the default arg.

**i18n:** 4 level labels + the control label → `i18n/messages/{en,zh-CN}/browser.json`, then `pnpm i18n:build && pnpm lint:i18n`. **Changeset:** minor.

---

# Phase 4 — Annotation lifecycle + batching

**Goal:** annotations become durable, triageable objects with a resolution loop — instead of being formatted, fired into chat, and forgotten.

**Borrowed from:** `package/src/types.ts` (`Annotation`, `AnnotationIntent/Severity/Status`, `ThreadMessage`) and the `agentation_watch_annotations` batching idea from `mcp/src/server/mcp.ts`.

**Gap (verified):** our annotations are **not persisted at all**. `useSelectionToChat.sendComment` (`hooks/browser/use-selection-to-chat.ts:~41`) formats and ships straight into the chat pipeline. There is no note store, no status, no thread, no batch.

### Design

**Dexie v111** (`lib/db/schema.ts` — current max is `version(110)` at `:2481`):

```ts
this.version(111).stores({
  browserAnnotations: "&id, sessionId, baseUrl, status, createdAt, [baseUrl+status]",
})
```

Row shape (trimmed to what we'll actually use — do not port their `x`/`y`/`drawingIndex`/`isFixed` marker-positioning fields; those serve their in-page marker UI, which we don't have):

- `intent: "fix" | "change" | "question" | "approve"`
- `severity: "blocking" | "important" | "suggestion"`
- `status: "pending" | "acknowledged" | "resolved" | "dismissed"`
- `thread: ThreadMessage[]`, `resolvedBy: "human" | "agent"`
- the `BrowserSelection` payload + the user's comment

**Batching (the real borrow):** their `agentation_watch_annotations` blocks until annotations arrive, then returns a batch — turning one-shot feedback into a continuous loop. **We do not need MCP or blocking for this**: annotate N elements → queue → send once. Implement as a queue in the pane with a "send N annotations" action.

### Traps

- **⚠️ Local-only. Do NOT register in `lib/sync`.** Follow `browserRecordings`' precedent and its stated reasoning (`lib/db/schema.ts:~2470-2480`): these reference **localhost dev-server URLs** and are worthless off-device. Syncing them pushes local URLs off the machine for no benefit. Mirror that comment.
- **Screenshots don't batch cleanly.** Today one screenshot auto-attaches per comment. N annotations must not mean N images in one message — decide the policy explicitly (recommend: one pane screenshot at send time, annotations referenced by index).
- The steer queue **drops image blocks** while streaming, which is why `sendComment` interrupts first (`use-selection-to-chat.ts:~64`). Preserve that behaviour in the batched path.
- Dexie tests: warm the DB in `beforeEach` — see the `goal-console-livequery-readonly-test-trap` pattern.

### Tests

`lib/db/browser-annotations.test.ts` (CRUD + status transitions), the queue/batch reducer, the schema version test, and an update to `use-selection-to-chat.test.ts`.

**i18n:** intent/severity/status labels + queue UI → `browser.json`, both locales. **Changeset:** minor.

---

# Phase 5 — Agent self-critique ("self-driving" design review)

**Goal:** the agent walks the page and files design annotations itself; the human triages them.

**Borrowed from:** `skills/agentation-self-driving/SKILL.md` — **the idea only**. See Non-goals: their method is coordinate-clicking workaround debt caused by not owning the browser.

**Why this is cheap for us:** we own the embed and already have snapshot + act-by-ref. The agent calls a tool; there is no overlay to punch through, no coordinate math, no eval-quoting hell.

### Design

- New tool in `plugins/browser-tools/src/index.ts`: `browser_annotate({ ref, comment, intent, severity })` — resolve `ref` → element via the existing `refMap`, build the `BrowserSelection` payload with the Phase 1 spatial context, write a Phase 4 row with `status: "pending"`.
- The agent's loop: `browser_snapshot` → pick targets → `browser_annotate` per finding.
- The human then triages the queue; resolved/dismissed feed back into the thread.
- Worth stealing verbatim from their skill: the **critique quality bar** (2–3 sentences, name the principle, 1–2 concrete alternatives, cite a comparable product) and their critique-area table (hero / nav / spacing rhythm / CTA weight). That part is genuinely good prompt engineering.

### Traps

- `plugins/browser-tools` is `permissions: ["agent:control"]` and **blocked on browser/mobile** (`lib/plugin/core/browser-builtin-registry.ts:~337`). The new tool inherits that gating — don't add a second gate.
- **Refs die per snapshot `generation`** (`overlay.injected.js:~809`). An annotation must **not** store a ref; resolve it to a selector + payload at annotate time, exactly as `refFor` bridges the recorder.
- Depends on Phase 4's store. Do not build a parallel one.

### Tests

Tool contract test in `plugins/browser-tools`; ref→payload resolution; a stale-generation ref is rejected cleanly.

**i18n:** any surfaced strings → `browser.json`. **Changeset:** minor.

---

# Phase 6 — Transport: signal-then-pull

> **Prerequisite for Phase 7.** Read the Key architectural finding first — this is _not_ the risky surgery it looks like.

**Goal:** decouple selection payload size from URL length by adopting the pull pattern `embedSnapshot` and the recorder already use.

**Gap:** selection pushes its full payload through the sentinel URL (`overlay.injected.js:9-14`), which is why `MAX_OUTER_HTML`/`MAX_PROPS_*` exist. Multi-select (N × 4000 chars) is unrepresentable through it — and Phase 3's `forensic` level and Phase 1's spatial block both push against the same ceiling.

### Design

1. Page buffers the selection(s) in a module var **and mirrors to `sessionStorage`** — copy `FlowRecorder`'s survival model (`overlay.injected.js:~1532`, restored `:~1728`).
2. Sentinel carries a **signal only**: `{ paneId, count, generation }`. Tiny, fixed size.
3. New command `browser_embed_drain_selection` → `eval_with_callback("__cogniaGetSelection()")` → returns the `{ok, error, selections: BrowserSelection[]}` envelope. **Model it directly on `browser_embed_snapshot`** — same envelope, same try/catch-returns-error-as-value discipline (Windows).
4. `browserClient.embedDrainSelection()` in `lib/browser/client.ts`, mirroring `embedSnapshot`.
5. Renderer: on `browser://element-selected` signal → drain → render.

Then **relax** `MAX_OUTER_HTML`/`MAX_PROPS_*` to the eval-return budget rather than the URL budget. Keep bounds — relax, don't remove.

### Traps

- **⚠️ Regression risk: today the payload is _in_ the sentinel, so it survives a page that navigates immediately after selection.** With signal-then-pull, a navigation between signal and drain loses it. **This is exactly why step 1 (sessionStorage mirror) is mandatory, not optional** — it lets the drain retry, precisely as the recorder tolerates a dead JS context (`recorder.ts` `poll()` catch branch). Do not ship the pull without the buffer.
- Keep the drain **idempotent-ish**: draining clears the buffer, but a failed drain must not.
- **Tear down the `sessionStorage` key on clear**, like the recorder does on stop (`:~1708`) — do not park user selections in the _visited site's_ storage.
- Register the command in `generate_handler!` + capabilities.

### Tests

`overlay.injected.test.ts` (buffer/restore/drain/clear, survives simulated navigation), `client.test.ts` (envelope parse, error branch), Rust `#[cfg(test)]`, and a **call-order test** pinning signal→drain (mirror ADR-0072's drain-then-resume ordering test).

### Verification

`pnpm tauri dev`: select an element on a page that navigates on click; confirm the payload still arrives. This is the phase's whole point — prove it live.

**Changeset:** patch (internal, but it unblocks user-facing work; ADR-0055/0072 addendum warranted).

---

# Phase 7 — Multi-select / area select / text select

**Goal:** annotate more than one element, an empty region, or a text range.

**Borrowed from:** agentation's drag-multi-select, area selection, and text selection (`Annotation.isMultiSelect`, `selectedText`, `elementBoundingBoxes`).

**Gap (verified — structural, not merely unimplemented):** `selectedEl` is a **scalar** (`overlay.injected.js:~44`), and `showSelection` calls `clearSelection()` first (`:~592`) — picking a second element _destroys_ the first by construction. Grepping `multi.?select|marquee|lasso|area.?select` and `getSelection|Range\(|selectionchange` across the subsystem returns zero hits.

### Design

- `selectedEl` / `selectedPayload` scalar → **array**. This is the core change; everything else follows.
- **Multi-select:** shift-click to add, plus a drag marquee that collects intersecting elements.
- **Area select:** drag on empty space → no element at all — just a rect + Phase 1 spatial context. (Agentation supports this; it's how you say "put something _here_".) Requires the payload type to allow an element-less selection.
- **Text select:** `window.getSelection()` → `Range` → `selectedText` on the payload.
- Panel shows N selections with per-item remove.
- `formatSelectionComment` → `formatSelectionsComment(sels[], comment, level)`.

### Traps

- **Phase 6 is a hard prerequisite.** Do not attempt this on the sentinel.
- **Per-element budget must drop as N rises.** Even on the pull channel, N × 4000 chars of `outerHTML` is a terrible prompt. Scale `MAX_OUTER_HTML` down with N (e.g. full detail at N=1, sharply reduced at N>3). State the policy in the payload so the model knows detail was reduced — do not truncate silently.
- **Area select breaks an invariant:** every consumer currently assumes a selection _has_ an element. Audit every `BrowserSelection` consumer before making the element optional.
- The panel self-destructs when its element unmounts (`:~575`) — that logic is per-element and needs a rethink for N.
- Marquee drag vs. the page's own drag handlers: our listeners are capture-phase; verify we don't break the previewed app.

### Tests

Scalar→array migration, shift-click accumulate, marquee intersection math, area-select with no element, text-range extraction, N-scaled truncation policy, panel remove-one. Plus `protocol.test.ts` for the multi-selection format.

**i18n:** panel N-selection strings → `browser.json`. **Changeset:** minor.

---

# Phase 8 — Design mode (rearrange)

> The expensive one. **Scope it as "describe the delta", not "edit the page".**

**Goal:** drag a page section to where it _should_ be; hand the agent a precise before/after delta to apply in source.

**Borrowed from:** `package/src/components/design-mode/` — `section-detection.ts` (~266 LOC), `rearrange.tsx` (~1060), `spatial.ts` (~755), `output.ts` (~441).

**Gap:** absent. Note `src-tauri/src/browser/mod.rs:1` currently advertises _"In-app browser (v0/Lovable-style visual editing)"_ — **false today.** This phase either makes it true or the comment must be corrected (see §Hygiene).

### Design

- **Section detection:** port their heuristic — `SECTION_TAGS` (nav/header/main/section/article/footer/aside), `SECTION_ROLES` (banner→Header, contentinfo→Footer, …), `MIN_SECTION_HEIGHT = 40`, and **`isEffectivelyFixed`** (walk ancestors for `position: fixed|sticky` — a fixed element doesn't scroll, so it can't be rearranged like a flow element). That last one is the non-obvious bit worth copying.
- **Ghost drag:** drag a translucent proxy. **The real DOM is never mutated.**
- **Output:** a `rearrange` annotation carrying `{ selector, label, tagName, originalRect, currentRect }` + Phase 1 parent-layout context, so the agent can reason "this was item 2 in a `flex column`; it is now above item 1 → reorder the JSX / change `order`."

### Traps

- **⚠️ Do not scope this as live style editing.** Agentation doesn't do it. Neither should we. The deliverable is a _described delta_, consumed by the same `resolutionDirective` path we already have.
- **Skip their wireframe/blank-canvas palette** (`palette.tsx` + `skeletons.tsx`, ~2100 LOC of hand-drawn SVG skeletons for 50+ component types). It is a _from-scratch page designer_, a different product from "fix this page", and it is the single largest chunk of their repo. If a wireframing tool is ever wanted, that's its own ADR — not a phase here.
- Their `COMPONENT_MAP`/`ComponentType` enum (50+ types) exists to serve that palette. Not needed for rearrange.
- Depends on Phase 6 (payload) and Phase 4 (annotation kind `rearrange`).

### Tests

Section detection (each tag/role branch, the fixed/sticky rejection, min-height), ghost drag math, delta output format.

### Before starting

This phase deserves WORKFLOW stages 2–3 (`superpowers:brainstorming` → `grilling`) and likely an **ADR**, not a direct jump to code. It is the only phase in this plan that changes the subsystem's product model.

**i18n:** mode toggle + section labels. **Changeset:** minor.

---

## Hygiene — two pre-existing defects found during the study

Unrelated to agentation; surfaced while auditing. Not phases — file them.

1. **`src-tauri/src/browser/mod.rs:1` is false.** It advertises "v0/Lovable-style visual editing"; no visual editing exists. Resolved by Phase 8, or correct the comment now. It is the most misleading line in the subsystem.
2. **ADR-0072:236-238 admits the record→replay smoke test "has not been performed as of this writing."** The `eval_with_callback` bridge is covered by neither jest nor cargo, so the entire recording path is **unverified against a live WKWebView/WebView2**. Phase 2 and Phase 6 both add traffic to that same bridge — worth clearing first. See the `tauri-smoke` skill.

---

## Licensing

Agentation is **PolyForm Shield 1.0.0** — it permits use but forbids building a competing product. We are borrowing **ideas, heuristics, and output formats**, and reimplementing in ES5 against our own architecture. That is the right side of the line, and this plan deliberately rejects wholesale porting of their largest components anyway. **Do not copy their source files verbatim into this repo.** If any phase starts looking like a file-for-file port, stop and escalate.

---

## Appendix — ideas evaluated and rejected

| Idea                                                          | Verdict                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| MCP server + HTTP + SSE + SQLite + webhooks + tenant-store    | ❌ Solves out-of-process delivery. We're in-process. Would also need Tauri axum (static export).                |
| `source-location.ts` `_debugSource` walk                      | ❌ **Trap.** Their own code documents React 19 breaking it. Our `data-inspector-*` approach is strictly better. |
| React fiber detection                                         | ❌ Ours is safer (never touches `_debugSource`).                                                                |
| `agentation_watch_annotations` as a _blocking MCP tool_       | 🟡 Idea borrowed (batching, Phase 4); mechanism rejected (we don't need MCP or blocking).                       |
| Self-driving skill's coordinate-click method                  | ❌ Workaround debt from not owning the browser. Idea borrowed in Phase 5; method rejected entirely.             |
| Wireframe palette + skeletons (~2100 LOC)                     | ❌ A from-scratch page designer. Different product. Own ADR if ever wanted.                                     |
| `COMPONENT_MAP` 50+ component-type enum                       | ❌ Only exists to serve the palette.                                                                            |
| In-page annotation markers (`x`/`y`/`isFixed`/`drawingIndex`) | ❌ Serves their in-page marker UI. Our selections flow to chat; no marker layer.                                |
| Zero-dependency / bundle-size discipline                      | ❌ Their npm constraint, not ours.                                                                              |
| Live style editing / palette swapping                         | ❌ **Agentation doesn't do this either.** Nobody has; don't scope it.                                           |

---

## Suggested dispatch

- **Now, in parallel (4 agents, no file overlap):** Phase 1, Phase 2, Phase 4, Phase 6.
- **Then:** Phase 3 (after 1), Phase 5 (after 4), Phase 7 (after 6).
- **Then, with brainstorm + grill + ADR first:** Phase 8.

Each phase must end with WORKFLOW stages 6→8: `verify`/`run` for real behaviour, then `preflight` (fans out the 6 auditors), then the gates — output pasted verbatim, never "should pass".
