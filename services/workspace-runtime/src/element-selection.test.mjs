import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_SELECTION_DRAIN_BYTES,
  SelectionError,
  normalizeAdjustRequest,
  normalizeAdjustResult,
  normalizePanelLabels,
  normalizeSelectionDrain,
  normalizeSelectionForRef,
} from "./element-selection.mjs"

const isSelectionError = (pattern) => (error) =>
  error instanceof SelectionError && pattern.test(error.message)

test("a drain stamps every pick with the pane and keeps the envelope's shape", () => {
  const raw = JSON.stringify({
    ok: true,
    error: null,
    selections: [{ selector: "#a" }, { selector: "#b" }],
  })
  assert.deepEqual(normalizeSelectionDrain(raw, "local:p1"), {
    ok: true,
    selections: [
      { selector: "#a", paneId: "local:p1" },
      { selector: "#b", paneId: "local:p1" },
    ],
  })
})

test("a drain refuses what a hostile page could hand back", () => {
  assert.throws(() => normalizeSelectionDrain(null, "p"), isSelectionError(/envelope/))
  assert.throws(() => normalizeSelectionDrain("[]", "p"), isSelectionError(/envelope/))
  assert.throws(() => normalizeSelectionDrain("{", "p"), isSelectionError(/envelope/))
  assert.throws(
    () => normalizeSelectionDrain(JSON.stringify({ ok: true, selections: "x" }), "p"),
    isSelectionError(/envelope/)
  )
  assert.throws(
    () => normalizeSelectionDrain(JSON.stringify({ ok: true, selections: [1] }), "p"),
    isSelectionError(/payload/)
  )
  assert.throws(
    () =>
      normalizeSelectionDrain(
        JSON.stringify({ ok: true, selections: Array.from({ length: 21 }, () => ({})) }),
        "p"
      ),
    isSelectionError(/item limit/)
  )
  assert.throws(
    () => normalizeSelectionDrain("x".repeat(MAX_SELECTION_DRAIN_BYTES + 1), "p"),
    isSelectionError(/byte limit/)
  )
  assert.throws(
    () => normalizeSelectionDrain(JSON.stringify({ ok: false, error: "drain exceeds" }), "p"),
    isSelectionError(/drain exceeds/)
  )
})

test("a selection for a ref passes the page's error through as a value", () => {
  assert.deepEqual(
    normalizeSelectionForRef(
      JSON.stringify({ ok: true, error: null, selection: { selector: "#x" } }),
      "p"
    ),
    { ok: true, error: null, selection: { selector: "#x", paneId: "p" } }
  )
  assert.deepEqual(
    normalizeSelectionForRef(
      JSON.stringify({ ok: false, error: "Unknown ref", selection: null }),
      "p"
    ),
    { ok: false, error: "Unknown ref", selection: null }
  )
  assert.throws(() => normalizeSelectionForRef("nope", "p"), isSelectionError(/envelope/))
})

test("panel labels are trimmed to two short strings or dropped", () => {
  assert.deepEqual(normalizePanelLabels({ details: "Details", collapse: "Hide", x: 1 }), {
    details: "Details",
    collapse: "Hide",
  })
  assert.equal(normalizePanelLabels({ details: "Details" }), null)
  assert.equal(normalizePanelLabels(null), null)
  assert.equal(normalizePanelLabels({ details: "d".repeat(100), collapse: "c" }).details.length, 64)
})

test("an adjust request keeps only the four draft fields and bounded strings", () => {
  assert.deepEqual(
    normalizeAdjustRequest("preview", {
      previewId: "p1",
      selector: "#t",
      draft: { font: "16px Inter", text: "", color: "red", onclick: "x" },
    }),
    {
      action: "preview",
      input: {
        previewId: "p1",
        selector: "#t",
        draft: { font: "16px Inter", text: "", color: "red" },
      },
    }
  )
  assert.deepEqual(normalizeAdjustRequest("revert", { previewId: "p1", selector: "#t" }), {
    action: "revert",
    input: { previewId: "p1" },
  })
  assert.throws(
    () => normalizeAdjustRequest("eval", { previewId: "p" }),
    isSelectionError(/action/)
  )
  assert.throws(() => normalizeAdjustRequest("revert", {}), isSelectionError(/previewId/))
  assert.throws(
    () => normalizeAdjustRequest("preview", { previewId: "p", selector: "s".repeat(2001) }),
    isSelectionError(/selector/)
  )
  assert.throws(
    () =>
      normalizeAdjustRequest("preview", { previewId: "p", selector: "#t", draft: { color: 1 } }),
    isSelectionError(/draft color/)
  )
})

test("an adjust result must be a JSON object", () => {
  assert.equal(normalizeAdjustResult('{"ok":true,"changes":[]}'), '{"ok":true,"changes":[]}')
  assert.throws(() => normalizeAdjustResult("[]"), isSelectionError(/adjust result/))
  assert.throws(() => normalizeAdjustResult(undefined), isSelectionError(/adjust result/))
})
