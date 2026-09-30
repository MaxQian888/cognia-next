# univer-inspired office-artifact gaps — verified against cognia-next

**Date:** 2026-09-29
**Status:** #1–#3 implemented 2026-09-29 (Q1 = A, Q2 = own parser + formulajs, Q3 = C deferred); see "Outcome" at the end
**Source study:** [dream-num/univer](https://github.com/dream-num/univer) v1.0.2 — "The Office Harness for AI Agents" (21.4k★, Apache-2.0, pnpm+turbo monorepo, ~59 `@univerjs/*` packages, `dev` default branch)

## How this document was produced

1. Studied Univer's README, repo metadata, package tree (`packages/`, `presets/`), OSS↔Pro feature split, and npm unpacked sizes.
2. Drafted candidate "ideas to borrow," then ran **three rounds of adversarial verification** against real cognia-next code, each round specifically hunting for counter-evidence (things that would falsify the claimed gap). Every claim below carries `file:line` evidence.

**Headline finding:** cognia already reimplemented Univer's core pattern deliberately. The `plugins/cognia-office|documents|presentations|pdf|visualize` stack provides plugin-owned XLSX/DOCX/PPTX authoring, import, preview, validation, export, and Lark sync, plus a structured agent mutation API (`office_apply_operations`) and version snapshots — the exact "structured Facade API over a document model" idea Univer is built on. `workbuddy-bench.test.ts` even benchmarks outputs against a Univer-based competitor. Wholesale Univer adoption is **rejected** (see appendix). What survives is four verified gaps.

**Legend:** ✅ CONFIRMED (absent, applicable, worth doing) · 🟡 PARTIAL (cognia partly does it; a specific slice is missing) · ❌ REJECTED (already implemented / not applicable — appendix).

---

## Tier 1 — Confirmed, genuinely absent, worth doing

| #   | Gap                                    | Effort  | Primary landing spot                                       | Decision gate |
| --- | -------------------------------------- | ------- | ---------------------------------------------------------- | ------------- |
| 1   | Agent render-verification tool         | S–M     | `lib/plugin/api/artifact-api.ts` + cognia-office runtime   | none          |
| 2   | Formula evaluation                     | M       | `plugins/cognia-office/src/model.ts` + new `evaluate.ts`   | Q2 (engine)   |
| 3   | Human-editable sheet preview           | M       | `plugins/cognia-office/src/preview.ts` split → `editor.ts` | Q1 (product)  |
| 4   | Connector-bound artifacts (data spine) | spike→L | new `binding` field + host-injected refresh                | Q3 (product)  |

### 1. Agents are blind to rendered output — capture tool ✅ (cheapest, do first)

- **Gap (verified):** `office_preview_workbook` only calls `ctx.artifact.openArtifact(id)` — it opens the preview **for the human** and returns `{ ok, artifactId }` to the agent (`plugins/cognia-office/src/tools.ts:149-154`). `office_inspect_workbook` returns structural summary only — sheet counts, `formulaCount`, warnings (`runtime.ts:128-140`). `office_validate_workbook` is structural (unsupported-feature findings, merge-overlap), not visual.
- **Counter-evidence checked and rejected:** `take_screenshot` (`plugins/screenshot/src/index.ts:99-160`) goes through `automation.captureDisplay` — an OS-level monitor/window grab, not an artifact-DOM capture; a human-visible hack, not a tool path. `frame-capture-registry.ts` exists but is wired to the export raster path only.
- **Why effective:** Univer's agent loop is edit → render → screenshot/layout-diagnostics → self-fix. Cognia's agent currently ships blind — a wrong-but-valid workbook passes every check it can run.
- **How:** add `artifact_capture` (generic, at the `artifact-api` layer so `cognia-documents`/`cognia-presentations` benefit too): mount the artifact's registered renderer in an offscreen container → reuse `lib/artifacts/export/raster.ts`'s capture path → return PNG as an MCP image. Handle the `formatNumber`-not-loaded loading state (`preview.ts:160-163`) — capture must await preview-engine readiness or return retryable.

### 2. Formulas are stored text + agent-asserted cached values — no evaluation ✅ (the real correctness gap)

- **Gap (verified):** no evaluator exists anywhere (repo-wide grep for `evaluate|compute|calculate|HyperFormula` hits only connector-policy/server-ops code). Instead:
  - `cellSchema` requires only `type`; `formula` and `value` are both optional (`tools.ts:356-366`) — an agent may legally write `{type:"number", formula:"SUM(A1:A5)"}` with **no** `value`, which renders blank in preview.
  - When a value is provided, the agent computed it — fixtures hand-set `formula:"B2*C2"` alongside `value:1000` (`workbuddy-bench.test.ts:18-20`).
  - `validateWorkbook` checks only that `cell.formula` is a non-empty string (`model.ts:280`); no syntax check, no consistency check between formula and cached value.
  - `recalculateOnOpen: true` is stamped on every document (`model.ts:61,173`, `xlsx.ts:58,142`) — the design explicitly defers computation to Excel on open. Import reads the source file's Excel-cached values (`xlsx.ts:184-186,233-235`).
  - `read_range` returns stored values verbatim (`read-range.ts:152-167`).
- **Why effective:** an agent that asserts a wrong cached value produces a preview that shows the wrong number until someone exports and Excel recalculates — silent wrongness in exactly the artifact users judge the agent by.
- **How:** keep `formula` as source of truth; make `value` derived. After `applyWorkbookOperations` commits, evaluate the affected cells and write back computed values. Import keeps file-cached values; export keeps `recalculateOnOpen` as belt-and-suspenders. Must define: circular references → error cells (precedent: `#REF!` from `formula-refs.ts` structural edits), unsupported functions → `#NAME?`, an evaluation budget so a huge sheet can't stall the tool.
- **Engine options (Q2):** (a) `fast-formula-parser` + `formulajs` — both MIT, compose a bounded evaluator, function coverage grows case-by-case; (b) Univer `engine-formula` headless — Apache-2.0 and complete, but ~40MB unpacked incl. wasm; must clear `predev` asset staging and Tauri/Capacitor webview compatibility; (c) hand-rolled subset (arithmetic, refs, SUM/AVG/IF family) — smallest, but owns the Excel-function long tail. **Excluded: HyperFormula is GPL-3.0** (commercial license available) — do not `pnpm add` it.

### 3. Sheet preview is read-only — humans cannot fix one cell ✅ (product-gated)

- **Gap (verified):** `preview.ts` renders a pure read-only `<table>` (sticky headers, frozen panes, filter chips, truncation notice, export bar); the entire cell-rendering region (lines 465-667) has **zero** event listeners or inputs. The plugin registers a renderer + importer + agent tools + result card — no editor contribution (`index.ts:56-93`). Mutations reach the model only via the agent's `office_apply_operations`.
- **Nuance (verified):** two escape hatches exist but neither is a spreadsheet UX — the artifact panel's Monaco is `readOnly:false` and edits the workbook's raw JSON (`components/artifacts/artifact-panel-content.tsx:197-210`); and `cognia-documents` proves renderer-driven mutation is an established pattern: its review rail's accept/reject buttons call `mutate(...)` issuing `{op:"acceptChange"}` (`plugins/cognia-documents/src/preview.ts:447-451`). So this is a sheets product choice, not an architecture limit. Optimistic concurrency (`expectedVersion`, `runtime.ts:166-168`) already exists for the human-vs-agent conflict case.
- **Why effective:** Univer's thesis is "people and AI agents work in the same files." Cognia's docs artifacts already honor it (review = human mutation); sheets don't — a human who spots one wrong cell must re-prompt the agent or hand-edit JSON.
- **How (if Q1 = yes):** extend the renderer with an edit mode mirroring documents' `mutate()` channel: cell click → inline input → commit `{op:"setCell"}`. MVP scope is value/formula entry only — no structural edits, no format toolbar; explicitly not rebuilding Excel. Define the `expectedVersion` conflict UX (banner + reload) for agent-vs-human collisions. Keep the validation rail; a human edit that introduces findings should surface them the same way.

### 4. No live-data spine into artifacts ✅ (product-level, spike only)

- **Gap (verified):** `runtime.syncLark` is strictly push — it calls `lark.sheets.create` to mint a **new** Lark spreadsheet from current values (`runtime.ts:283-303`); no update-back, pull, or subscription. `lib/artifacts/dexie-bridge.ts` is a store↔Dexie persistence mirror, not a data binding. `lib/artifacts/interactive-html.ts` shows the sandbox is sealed by design (opaque origin, no host access, no network) — so binding must be **host-injected**, never artifact-fetched.
- **Why effective:** Univer Workspace's differentiator is mini-apps whose controls/charts bind to cells and stay live across people and agents. Cognia's equivalent would be artifacts bound to connector data (Lark sheets, GitHub, Slack-derived tables) that refresh — a real product differentiator on top of the existing connector ecosystem.
- **How:** spike only — candidate MVP is a `binding` field on a workbook sheet pointing at a connector query, refreshed via the existing `applyOperations`+version-history machinery (scheduled or on-open). Output: ADR draft + throwaway prototype, not product code.

---

## Decision gates (before implementation)

| #   | Question                                       | Options                                                               | Unblocks |
| --- | ---------------------------------------------- | --------------------------------------------------------------------- | -------- |
| Q1  | May humans edit workbook cells in the preview? | A. yes (documents' mutate precedent) / B. agent-only stays            | #3       |
| Q2  | Formula engine choice                          | A. MIT mini-engine / B. Univer `engine-formula` wasm / C. hand-rolled | #2       |
| Q3  | Data-binding MVP form                          | A. workbook↔connector query / B. a2ui surface / C. defer              | #4       |

## Rejected — verified already-implemented or not applicable (do not re-propose)

Checked against real code; recorded so nobody re-litigates.

- **Unified Facade API** ❌ — `lib/plugin/api/` already provides ~50 per-domain `*-api.ts` facades; same pattern.
- **Preset/plugin curated composition** ❌ — `lib/presets/` (`categories`, `group-presets`, `apply-to-session`).
- **Headless Node runtime** ❌ — `sidecar/` runs agent execution unbuilt by Node (ADR-0197).
- **Agent draft → human review/merge** ❌ — `lib/work-submission/` + `lib/review/` + task-workspace git worktrees.
- **Sandboxed artifact preview + frame capture** ❌ — `lib/artifacts/` preview-registry + `frame-capture-registry` (export path); #1 reuses it, doesn't rebuild it.
- **Lazy-loaded plugins** ❌ — dynamic imports already in use (`lib/plugin/lifecycle/updater.ts:294`).
- **Structured mutation API for office docs** ❌ — `office_apply_operations` (11 tools incl. `read_range`, `inspect`, `validate`, `list_versions`, `restore_version`) plus Excel-grade structural reference rewriting (`formula-refs.ts`: insert shifts refs, delete → `#REF!`, rename propagates, absolute `$` preserved, 3D refs, external-workbook refs untouched).
- **Office documents as first-class artifacts** ❌ — already shipped as plugins; model + tools + preview + import/export + validation findings for 18 unsupported OOXML feature classes.
- **Own OOXML codecs** ❌ — `xlsx.ts`/`docx.ts`/`pptx.ts` hand-built; this is also why Univer's "import/export is Pro-only" boundary is moot here — cognia owns the moat already.
- **Command/mutation bus with undo + collab changesets** 🟡-rejected-for-now — cognia has coarse version snapshots + restore, not command-level undo or OT. Only worth it if realtime collaboration lands; don't build speculatively.
- **Embedding Univer wholesale** ❌ — sheets preset dep tree ≈ 168MB unpacked (`engine-formula` 40MB w/ wasm, `ui` 55MB, `engine-render` 28MB); Pro gates import/export/charts/pivot/print/collab; adopting it would force rewriting `cognia-office`'s deliberately-narrowed model, tools, and validation. All `@univerjs/*` must pin one release line if any single package is ever adopted.

**Compatibility notes if a Univer package is ever vendored:** React 18 view layer (React 19 supported), Chrome 88 baseline + `Intl.Segmenter` polyfill need, Canvas-render performance on Capacitor webviews unproven — measure before shipping to mobile.

## Suggested sequencing

1. **`artifact_capture` tool** (#1): small, benefits all three office plugins, immediately closes the agent blind-delivery loop.
2. **Formula evaluation** (#2, after Q2): the only hard correctness gap; prefer the MIT mini-engine unless coverage demands prove otherwise.
3. **Editable preview** (#3, after Q1): reuse documents' mutate precedent; strictly `setCell`-only MVP.
4. **Binding spike** (#4): explore behind Q3; the sandbox-sealed constraint shapes whatever ships.

The thesis to keep from Univer even where cognia already wins: **documents are agent-operated surfaces, not generated text** — cognia's office stack already encodes this; the four gaps are all about closing the loop (verify visually, compute honestly, let humans fix, keep data live) rather than opening a new surface.

## Outcome (2026-09-29)

Decisions: **Q1 = A** (setCell-only human editing), **Q2 = own parser + `@formulajs/formulajs`** (MIT; a variant of option A — `fast-formula-parser` has been unmaintained since 2020, and `formula-refs.ts` already owned the reference grammar), **Q3 = C** (#4 deferred; it was a spike, not product code).

- **#1 → `artifact_capture`**, a host built-in artifact tool (`lib/claude/artifact-builtin-tools.ts`), not a new `ctx.artifact` method: one tool covers every artifact kind with no new plugin-API surface to version across the five contract mirrors. Plugin renderers are mounted off-screen via `mount → ready → dispose` (`captureArtifactToPngBlob` in `lib/artifacts/export/raster.ts`; `ArtifactRendererHandle.ready` added, implemented by cognia-office and cognia-pdf, the two renderers that paint asynchronously); dock-only previews (chart / mermaid / react) are revealed and captured there (`lib/artifacts/capture.ts`). The capture must not wait on `requestAnimationFrame` — a backgrounded window never runs one. ADR-0158 carries the amendment.
- **#2 → `plugins/cognia-office/src/formula-{parser,eval}.ts`**: recalculated on every create/edit (not import), SCC-ordered (iterative Tarjan), cycles → `#REF!`, unevaluable formulas keep their cached value, all-or-nothing under formula/edge/read/time budgets; the tool result carries a `recalculation` report.
- **#3 → `plugins/cognia-office/src/cell-editor.ts`**: an ARIA grid decorating the existing preview table, committing through the same versioned, recalculated `applyOperations` path as the agent (setCell, plus clear-contents for Delete), with a conflict notice on `expectedVersion` mismatch and one spare row/column to type into.
