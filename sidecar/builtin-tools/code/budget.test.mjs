import test from "node:test"
import assert from "node:assert/strict"

import { computeBudget, packSnippets } from "./budget.mjs"

test("computeBudget scales down as file count grows", () => {
  const small = computeBudget(50)
  const mid = computeBudget(500)
  const big = computeBudget(3000)
  const huge = computeBudget(20000)
  assert.ok(small.maxOutputChars > mid.maxOutputChars)
  assert.ok(mid.maxOutputChars > big.maxOutputChars)
  assert.ok(big.maxOutputChars > huge.maxOutputChars)
  // per-file cap clamped within [1500, 7000]
  for (const b of [small, mid, big, huge]) {
    assert.ok(b.maxCharsPerFile >= 1500 && b.maxCharsPerFile <= 7000)
  }
})

test("computeBudget tolerates bogus input", () => {
  assert.equal(computeBudget(0).maxOutputChars, 24000)
  assert.equal(computeBudget(-5).maxOutputChars, 24000)
  assert.equal(computeBudget(NaN).maxOutputChars, 24000)
})

test("packSnippets keeps whole snippets within total budget", () => {
  const items = [
    { id: "a", file: "a.ts", text: "x".repeat(100) },
    { id: "b", file: "b.ts", text: "y".repeat(100) },
    { id: "c", file: "c.ts", text: "z".repeat(100) },
  ]
  const { kept, dropped, usedChars } = packSnippets(items, {
    maxOutputChars: 250,
    maxCharsPerFile: 1000,
  })
  assert.deepEqual(
    kept.map((k) => k.id),
    ["a", "b"]
  )
  assert.equal(usedChars, 200)
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].reason, "budget")
})

test("packSnippets drops oversized snippets whole (never truncates)", () => {
  const items = [
    { id: "big", file: "big.ts", text: "x".repeat(5000) },
    { id: "ok", file: "ok.ts", text: "y".repeat(100) },
  ]
  const { kept, dropped } = packSnippets(items, {
    maxOutputChars: 10000,
    maxCharsPerFile: 1000,
  })
  assert.deepEqual(
    kept.map((k) => k.id),
    ["ok"]
  )
  assert.equal(dropped[0].id, "big")
  assert.equal(dropped[0].reason, "too-large")
})

test("packSnippets keeps scanning for smaller snippets after a budget drop", () => {
  const items = [
    { id: "big", file: "1.ts", text: "x".repeat(200) },
    { id: "small", file: "2.ts", text: "y".repeat(10) },
  ]
  const { kept } = packSnippets(items, { maxOutputChars: 150, maxCharsPerFile: 1000 })
  // big exceeds total budget → dropped; small still fits.
  assert.deepEqual(
    kept.map((k) => k.id),
    ["small"]
  )
})

test("packSnippets tolerates non-array and missing text", () => {
  assert.deepEqual(packSnippets(null, { maxOutputChars: 10, maxCharsPerFile: 10 }).kept, [])
  const { kept } = packSnippets([{ id: "x" }], { maxOutputChars: 10, maxCharsPerFile: 10 })
  assert.equal(kept.length, 1) // empty text, length 0, fits
})
