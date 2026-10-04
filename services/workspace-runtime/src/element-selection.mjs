// Element pick and Browser Adjust for local pages (ADR-0214). The page side is
// the injected overlay (`lib/browser/overlay.injected.js`), the same code the
// embedded webview runs. These helpers check what comes back from it: a page
// can replace any `window.__cognia*` function, so its answers are untrusted
// input and are size-capped and shape-checked before they leave the runtime.

/** The overlay calls `window.__cogniaSignal({count, generation})` after a pick. */
export const SELECTION_SIGNAL_BINDING = "__cogniaSignal"

/** Same caps as the embedded webview's drain (`src-tauri/src/browser/embedded.rs`). */
export const MAX_SELECTION_DRAIN_BYTES = 200_000
export const MAX_SELECTIONS = 20

const MAX_PANEL_LABEL = 64
const MAX_PREVIEW_ID = 200
const MAX_SELECTOR = 2_000
const MAX_DRAFT_VALUE = 1_000
const ADJUST_DRAFT_KEYS = ["font", "text", "spacing", "color"]

export class SelectionError extends Error {
  constructor(message) {
    super(message)
    this.name = "SelectionError"
  }
}

function parseObject(raw, message) {
  if (typeof raw !== "string") throw new SelectionError(message)
  if (raw.length > MAX_SELECTION_DRAIN_BYTES) {
    throw new SelectionError("selection drain exceeds byte limit")
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new SelectionError(message)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelectionError(message)
  }
  return value
}

function withPane(selection, paneId) {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new SelectionError("invalid selection drain payload")
  }
  return { ...selection, paneId }
}

function assertSize(value) {
  if (JSON.stringify(value).length > MAX_SELECTION_DRAIN_BYTES) {
    throw new SelectionError("selection drain exceeds byte limit")
  }
  return value
}

/**
 * `window.__cogniaGetSelection()`'s JSON envelope → the picks, each stamped
 * with the pane that shows the page. A page-reported failure is an error.
 */
export function normalizeSelectionDrain(raw, paneId) {
  const envelope = parseObject(raw, "invalid selection drain envelope")
  if (envelope.ok !== true) {
    throw new SelectionError(
      typeof envelope.error === "string" ? envelope.error.slice(0, 500) : "selection drain failed"
    )
  }
  if (!Array.isArray(envelope.selections)) {
    throw new SelectionError("invalid selection drain envelope")
  }
  if (envelope.selections.length > MAX_SELECTIONS) {
    throw new SelectionError("selection drain exceeds item limit")
  }
  return assertSize({
    ok: true,
    selections: envelope.selections.map((selection) => withPane(selection, paneId)),
  })
}

/** `window.__cogniaSelectionForRef(ref)`'s JSON envelope → one selection. */
export function normalizeSelectionForRef(raw, paneId) {
  const envelope = parseObject(raw, "invalid selection envelope")
  if (envelope.ok !== true || !envelope.selection) {
    return {
      ok: false,
      error: typeof envelope.error === "string" ? envelope.error.slice(0, 500) : "selection failed",
      selection: null,
    }
  }
  return assertSize({ ok: true, error: null, selection: withPane(envelope.selection, paneId) })
}

/** The info panel's two localized toggle labels, or null for "keep the defaults". */
export function normalizePanelLabels(labels) {
  if (!labels || typeof labels !== "object") return null
  const details = typeof labels.details === "string" ? labels.details.slice(0, MAX_PANEL_LABEL) : ""
  const collapse =
    typeof labels.collapse === "string" ? labels.collapse.slice(0, MAX_PANEL_LABEL) : ""
  return details && collapse ? { details, collapse } : null
}

function boundedString(value, max, field) {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new SelectionError(`invalid ${field}`)
  }
  return value
}

/** Checks an Adjust request before it is handed to the page as JSON. */
export function normalizeAdjustRequest(action, input) {
  if (action !== "preview" && action !== "revert") {
    throw new SelectionError("invalid adjust action")
  }
  const source = input && typeof input === "object" ? input : {}
  const previewId = boundedString(source.previewId, MAX_PREVIEW_ID, "previewId")
  if (action === "revert") return { action, input: { previewId } }
  const selector = boundedString(source.selector, MAX_SELECTOR, "selector")
  const draft = {}
  const rawDraft = source.draft && typeof source.draft === "object" ? source.draft : {}
  for (const key of ADJUST_DRAFT_KEYS) {
    const value = rawDraft[key]
    if (value === undefined) continue
    if (typeof value !== "string" || value.length > MAX_DRAFT_VALUE) {
      throw new SelectionError(`invalid draft ${key}`)
    }
    draft[key] = value
  }
  return { action, input: { previewId, selector, draft } }
}

/** `window.__cogniaAdjust` answers with a JSON string; pass it on only if it is one. */
export function normalizeAdjustResult(raw) {
  const envelope = parseObject(raw, "invalid adjust result")
  return JSON.stringify(envelope)
}
