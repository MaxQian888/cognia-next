// Tests for the diagnostics debounce/dedupe/version-guard stage.

import { test } from "node:test"
import assert from "node:assert/strict"

const { DiagnosticsBuffer, dedupeDiagnostics, DIAGNOSTICS_DEBOUNCE_MS } =
  await import("../dist/lsp-diagnostics-buffer.js")

function diag(message, line = 0, extra = {}) {
  return {
    message,
    severity: 1,
    range: { start: { line, character: 0 }, end: { line, character: 5 } },
    ...extra,
  }
}

/** Manual timer harness — fire callbacks deterministically. */
function makeTimers() {
  let nextId = 1
  const pending = new Map()
  return {
    setTimeout: (cb, ms) => {
      const id = nextId++
      pending.set(id, { cb, ms })
      return id
    },
    clearTimeout: (id) => {
      pending.delete(id)
    },
    fireAll() {
      const entries = [...pending.values()]
      pending.clear()
      for (const { cb } of entries) cb()
    },
    pendingCount: () => pending.size,
  }
}

test("dedupeDiagnostics drops exact duplicates, keeps order", () => {
  const a = diag("a")
  const b = diag("b", 2)
  const out = dedupeDiagnostics([a, { ...a }, b, { ...b }, a])
  assert.deepEqual(
    out.map((d) => d.message),
    ["a", "b"]
  )
})

test("dedupeDiagnostics keeps same-message diagnostics at different ranges", () => {
  const out = dedupeDiagnostics([diag("x", 1), diag("x", 2)])
  assert.equal(out.length, 2)
})

test("debounce coalesces bursts — only the last frame per key:uri emits", () => {
  const timers = makeTimers()
  const emitted = []
  const buffer = new DiagnosticsBuffer((key, params) => emitted.push({ key, params }), timers)

  buffer.ingest("agent:ts", { uri: "file:///a.ts", diagnostics: [diag("first")] }, null)
  buffer.ingest("agent:ts", { uri: "file:///a.ts", diagnostics: [diag("second")] }, null)
  assert.equal(emitted.length, 0, "nothing emits before the window closes")
  assert.equal(timers.pendingCount(), 1, "burst frames collapse onto one timer")

  timers.fireAll()
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].params.diagnostics[0].message, "second")
})

test("distinct uris debounce independently", () => {
  const timers = makeTimers()
  const emitted = []
  const buffer = new DiagnosticsBuffer((key, params) => emitted.push({ key, params }), timers)
  buffer.ingest("agent:ts", { uri: "file:///a.ts", diagnostics: [diag("a")] }, null)
  buffer.ingest("agent:ts", { uri: "file:///b.ts", diagnostics: [diag("b")] }, null)
  timers.fireAll()
  assert.equal(emitted.length, 2)
})

test("stale frames (version < current document version) are dropped", () => {
  const timers = makeTimers()
  const emitted = []
  const buffer = new DiagnosticsBuffer((key, params) => emitted.push({ key, params }), timers)
  // Document is at version 5; a version-3 frame is pre-edit garbage.
  buffer.ingest("agent:ts", { uri: "file:///a.ts", version: 3, diagnostics: [diag("stale")] }, 5)
  timers.fireAll()
  assert.equal(emitted.length, 0)

  // Same-version (and untagged) frames pass.
  buffer.ingest("agent:ts", { uri: "file:///a.ts", version: 5, diagnostics: [diag("fresh")] }, 5)
  buffer.ingest("agent:ts", { uri: "file:///b.ts", diagnostics: [diag("untagged")] }, 5)
  timers.fireAll()
  assert.equal(emitted.length, 2)
})

test("cancelKey drops pending frames for that key only", () => {
  const timers = makeTimers()
  const emitted = []
  const buffer = new DiagnosticsBuffer((key, params) => emitted.push({ key, params }), timers)
  buffer.ingest("agent:ts", { uri: "file:///a.ts", diagnostics: [diag("a")] }, null)
  buffer.ingest("user:py", { uri: "file:///b.py", diagnostics: [diag("b")] }, null)
  buffer.cancelKey("agent:ts")
  timers.fireAll()
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].key, "user:py")
})

test("dispose cancels everything", () => {
  const timers = makeTimers()
  const emitted = []
  const buffer = new DiagnosticsBuffer((key, params) => emitted.push({ key, params }), timers)
  buffer.ingest("agent:ts", { uri: "file:///a.ts", diagnostics: [diag("a")] }, null)
  buffer.dispose()
  timers.fireAll()
  assert.equal(emitted.length, 0)
})

test("exports a debounce window comfortably below the agent's 800ms wait", () => {
  assert.ok(DIAGNOSTICS_DEBOUNCE_MS < 800)
})
