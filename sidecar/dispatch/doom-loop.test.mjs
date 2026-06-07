import { test } from "node:test"
import assert from "node:assert/strict"

import { createDoomLoopGuard, stableStringify, DEFAULT_DOOM_THRESHOLD } from "./doom-loop.mjs"

test("third identical call trips the guard", () => {
  const g = createDoomLoopGuard()
  assert.equal(g.check("grep", { pattern: "x" }), null)
  assert.equal(g.check("grep", { pattern: "x" }), null)
  assert.equal(g.check("grep", { pattern: "x" }), "ask")
  // Stays tripped on further repeats.
  assert.equal(g.check("grep", { pattern: "x" }), "ask")
})

test("different inputs and different tools track independently", () => {
  const g = createDoomLoopGuard()
  g.check("grep", { pattern: "x" })
  g.check("grep", { pattern: "x" })
  assert.equal(g.check("grep", { pattern: "y" }), null)
  assert.equal(g.check("glob", { pattern: "x" }), null)
})

test("key order does not matter for the signature", () => {
  const g = createDoomLoopGuard({ threshold: 2 })
  assert.equal(g.check("t", { a: 1, b: 2 }), null)
  assert.equal(g.check("t", { b: 2, a: 1 }), "ask")
})

test("reset clears the counters", () => {
  const g = createDoomLoopGuard({ threshold: 2 })
  g.check("t", {})
  g.reset()
  assert.equal(g.check("t", {}), null)
})

test("stableStringify sorts keys recursively and handles arrays/primitives", () => {
  assert.equal(stableStringify({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}')
  assert.equal(stableStringify("s"), '"s"')
  assert.equal(stableStringify(3), "3")
})

test("default threshold is 3", () => {
  assert.equal(DEFAULT_DOOM_THRESHOLD, 3)
})
