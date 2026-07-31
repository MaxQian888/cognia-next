import { test } from "node:test"
import assert from "node:assert/strict"

import { headTruncate, tailTruncate, DEFAULT_TAIL_MAX } from "./truncate.mjs"

test("headTruncate leaves short strings untouched", () => {
  assert.deepEqual(headTruncate("x".repeat(10), 100), { text: "x".repeat(10), truncated: false })
})

test("headTruncate keeps the head and appends the marker", () => {
  const t = headTruncate("y".repeat(500), 50)
  assert.equal(t.truncated, true)
  assert.equal(t.text, "y".repeat(50) + "\n... (truncated)")
  assert.match(t.text, /truncated/)
})

test("headTruncate default predicate is exclusive (length > max)", () => {
  // exactly max → NOT truncated (git semantics)
  assert.deepEqual(headTruncate("abcde", 5), { text: "abcde", truncated: false })
})

test("headTruncate inclusive predicate truncates at length >= max", () => {
  // exactly max → truncated (shell-advanced semantics)
  const t = headTruncate("abcde", 5, { inclusive: true })
  assert.equal(t.truncated, true)
  assert.equal(t.text, "abcde\n... (truncated)")
})

test("headTruncate honours a custom marker", () => {
  const t = headTruncate("abcdef", 3, { marker: "[cut]" })
  assert.equal(t.text, "abc[cut]")
})

test("tailTruncate leaves short strings untouched", () => {
  assert.deepEqual(tailTruncate("short", 10), { text: "short", truncated: false })
})

test("tailTruncate keeps the tail with a dropped-count note", () => {
  const t = tailTruncate("a".repeat(100), 10)
  assert.equal(t.truncated, true)
  assert.equal(t.text, `… (90 earlier characters dropped)\n${"a".repeat(10)}`)
})

test("tailTruncate default max is DEFAULT_TAIL_MAX", () => {
  assert.equal(DEFAULT_TAIL_MAX, 30_000)
  assert.equal(tailTruncate("x".repeat(100)).truncated, false)
})
