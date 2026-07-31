import { test } from "node:test"
import assert from "node:assert/strict"

import { MIME_BY_EXT, mimeForPath } from "./mime.mjs"

test("mimeForPath maps known extensions", () => {
  assert.equal(mimeForPath("a.json"), "application/json")
  assert.equal(mimeForPath("a.ts"), "text/typescript")
  assert.equal(mimeForPath("a.png"), "image/png")
})

test("mimeForPath is case-insensitive on the extension", () => {
  assert.equal(mimeForPath("README.MD"), "text/markdown")
})

test("mimeForPath falls back to octet-stream for unknown extensions", () => {
  assert.equal(mimeForPath("a.unknown"), "application/octet-stream")
  assert.equal(mimeForPath("noext"), "application/octet-stream")
})

test("MIME_BY_EXT is the backing map", () => {
  assert.equal(MIME_BY_EXT.get(".pdf"), "application/pdf")
})
