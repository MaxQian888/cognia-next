import { test } from "node:test"
import assert from "node:assert/strict"

import { applyMarkerBlock, hasMarkerBlock, MARKER_START, MARKER_END } from "./gitignore.mjs"

const LINES = ["/.cognia/clonedeps/repos/"]

test("applyMarkerBlock appends a block to an empty file", () => {
  const out = applyMarkerBlock("", LINES)
  assert.ok(out.includes(MARKER_START))
  assert.ok(out.includes("/.cognia/clonedeps/repos/"))
  assert.ok(out.includes(MARKER_END))
  assert.ok(out.endsWith("\n"))
})

test("applyMarkerBlock appends after existing content with a separating blank line", () => {
  const out = applyMarkerBlock("node_modules\n", LINES)
  assert.ok(out.startsWith("node_modules\n"))
  assert.ok(out.includes(MARKER_START))
})

test("applyMarkerBlock adds a newline when existing content lacks a trailing one", () => {
  const out = applyMarkerBlock("dist", LINES)
  assert.match(out, /dist\n\n# >>> cognia clonedeps/)
})

test("applyMarkerBlock is idempotent", () => {
  const once = applyMarkerBlock("node_modules\n", LINES)
  const twice = applyMarkerBlock(once, LINES)
  assert.equal(twice, once)
})

test("applyMarkerBlock replaces an existing managed block in place", () => {
  const stale = `a\n${MARKER_START}\n/old/path\n${MARKER_END}\nb\n`
  const out = applyMarkerBlock(stale, LINES)
  assert.ok(!out.includes("/old/path"))
  assert.ok(out.includes("/.cognia/clonedeps/repos/"))
  assert.ok(out.startsWith("a\n"))
  assert.ok(out.endsWith("b\n"))
  // Exactly one managed block.
  assert.equal(out.split(MARKER_START).length - 1, 1)
})

test("hasMarkerBlock reports whether the block is already present and current", () => {
  assert.equal(hasMarkerBlock("", LINES), false)
  const withBlock = applyMarkerBlock("", LINES)
  assert.equal(hasMarkerBlock(withBlock, LINES), true)
})
