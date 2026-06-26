import { test } from "node:test"
import assert from "node:assert/strict"

import {
  createDoomLoopGuard,
  stableStringify,
  DEFAULT_DOOM_THRESHOLD,
  DEFAULT_DOOM_MAX_ENTRIES,
} from "./doom-loop.mjs"

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

test("default max-entries cap is exported and positive", () => {
  assert.equal(typeof DEFAULT_DOOM_MAX_ENTRIES, "number")
  assert.ok(DEFAULT_DOOM_MAX_ENTRIES > 0)
})

test("distinct signatures are evicted oldest-first once over the cap", () => {
  const g = createDoomLoopGuard({ threshold: 2, maxEntries: 3 })
  // Fill the cap with 3 distinct signatures (each seen once).
  g.check("t", { i: 0 })
  g.check("t", { i: 1 })
  g.check("t", { i: 2 })
  // A 4th distinct signature evicts the oldest ({ i: 0 }).
  g.check("t", { i: 3 })
  // The evicted signature's count is gone — its next call starts from 1, not 2.
  assert.equal(g.check("t", { i: 0 }), null)
})

test("the signature touched on the current call is never the eviction victim", () => {
  const g = createDoomLoopGuard({ threshold: 2, maxEntries: 2 })
  g.check("a", {}) // { a }
  g.check("b", {}) // { a, b }
  g.check("c", {}) // insert c → over cap → evict oldest (a); { b, c }
  // `c` was just inserted, so it must have survived: its 2nd call trips.
  assert.equal(g.check("c", {}), "ask")
  // `a` was evicted, so its count restarted from 1.
  assert.equal(g.check("a", {}), null)
})

test("consecutive repeats trip even amid distinct churn within the cap", () => {
  const g = createDoomLoopGuard({ threshold: 3, maxEntries: DEFAULT_DOOM_MAX_ENTRIES })
  // A runaway loop repeats the SAME call in quick succession; interleaved
  // distinct calls stay well under the default cap, so the count survives.
  assert.equal(g.check("grep", { p: "x" }), null)
  g.check("read", { f: "a" })
  assert.equal(g.check("grep", { p: "x" }), null)
  g.check("read", { f: "b" })
  assert.equal(g.check("grep", { p: "x" }), "ask")
})
