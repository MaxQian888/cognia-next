/**
 * Coverage for scripts/sort-i18n.mjs — the pure sort/serialise helpers.
 *
 * Run with: node --test scripts/sort-i18n.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { sortDeep, serialize } from "./sort-i18n.mjs"

test("sortDeep orders keys alphabetically at every depth", () => {
  const input = { b: 1, a: { z: 1, y: 2 }, c: 3 }
  assert.deepEqual(Object.keys(sortDeep(input)), ["a", "b", "c"])
  assert.deepEqual(Object.keys(sortDeep(input).a), ["y", "z"])
})

test("sortDeep preserves array order and primitive values", () => {
  const input = { list: ["c", "a", "b"], n: 5, s: "hi" }
  const out = sortDeep(input)
  assert.deepEqual(out.list, ["c", "a", "b"])
  assert.equal(out.n, 5)
  assert.equal(out.s, "hi")
})

test("sortDeep never mutates values, only key order", () => {
  const input = { greeting: "Hello {name}, you have {count} items" }
  assert.equal(sortDeep(input).greeting, "Hello {name}, you have {count} items")
})

test("serialize emits prettier-compatible JSON (LF, 2-space, trailing newline)", () => {
  const out = serialize({ b: 1, a: 2 })
  assert.equal(out, '{\n  "a": 2,\n  "b": 1\n}\n')
  assert.ok(!out.includes("\r\n"))
  assert.ok(out.endsWith("\n"))
})

test("serialize is idempotent (sorting a sorted object is a no-op)", () => {
  const once = serialize({ b: 1, a: 2 })
  const twice = serialize(JSON.parse(once))
  assert.equal(once, twice)
})
