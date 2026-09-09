import { test } from "node:test"
import assert from "node:assert/strict"

import {
  MODEL_TOOL_NAME_PATTERN,
  isModelSafeToolName,
  modelToolName,
  restoreToolName,
  sanitizeModelToolName,
  sanitizeToolMap,
} from "./ai-sdk-tool-names.mjs"

test("safe names pass through untouched", () => {
  for (const name of ["read", "git_status", "mcp__docs__search", "Tool-Search", "a".repeat(64)]) {
    assert.equal(isModelSafeToolName(name), true, name)
    assert.equal(sanitizeModelToolName(name), name)
  }
})

test("illegal characters become underscores and the result satisfies the provider pattern", () => {
  assert.equal(sanitizeModelToolName("ocr.extract"), "ocr_extract")
  assert.equal(sanitizeModelToolName("mcp__docs__page/search"), "mcp__docs__page_search")
  assert.equal(sanitizeModelToolName("web:fetch url"), "web_fetch_url")
  assert.equal(sanitizeModelToolName("日本語"), sanitizeModelToolName("日本語"))
  for (const name of ["ocr.extract", "a b", "x/y", "日本語", "", "...", "a".repeat(100)]) {
    assert.match(sanitizeModelToolName(name), MODEL_TOOL_NAME_PATTERN, name)
  }
})

test("an empty or all-punctuation name gets a hashed name instead of a bare underscore", () => {
  const dots = sanitizeModelToolName("...")
  assert.match(dots, /^tool_[0-9a-f]{7}$/)
  assert.notEqual(dots, sanitizeModelToolName("!!!"))
})

test("an over-long name keeps its head and a hash of the whole, so long twins stay distinct", () => {
  const a = sanitizeModelToolName(`${"x".repeat(70)}a`)
  const b = sanitizeModelToolName(`${"x".repeat(70)}b`)
  assert.equal(a.length, 64)
  assert.equal(b.length, 64)
  assert.notEqual(a, b)
  assert.ok(a.startsWith("x".repeat(56)))
})

test("sanitizeToolMap renames only the offenders, records aliases, and keeps order", () => {
  const read = { description: "read" }
  const ocr = { description: "ocr" }
  const mcp = { description: "mcp" }
  const { tools, aliases } = sanitizeToolMap({
    "mcp__docs__page/search": mcp,
    "ocr.extract": ocr,
    read,
  })
  assert.deepEqual(Object.keys(tools), ["mcp__docs__page_search", "ocr_extract", "read"])
  assert.equal(tools.ocr_extract, ocr)
  assert.equal(tools.read, read)
  assert.deepEqual(
    [...aliases],
    [
      ["mcp__docs__page_search", "mcp__docs__page/search"],
      ["ocr_extract", "ocr.extract"],
    ]
  )
  assert.equal(restoreToolName(aliases, "ocr_extract"), "ocr.extract")
  assert.equal(restoreToolName(aliases, "read"), "read")
  assert.equal(modelToolName(aliases, "ocr.extract"), "ocr_extract")
  assert.equal(modelToolName(aliases, "read"), "read")
  assert.equal(restoreToolName(undefined, "ocr_extract"), "ocr_extract")
})

test("a rename that collides with an existing or renamed key gets a numeric suffix", () => {
  const { tools, aliases } = sanitizeToolMap({
    ocr_extract: { description: "already safe" },
    "ocr.extract": { description: "dotted" },
    "ocr/extract": { description: "slashed" },
  })
  assert.deepEqual(Object.keys(tools), ["ocr_extract", "ocr_extract_2", "ocr_extract_3"])
  assert.equal(aliases.get("ocr_extract_2"), "ocr.extract")
  assert.equal(aliases.get("ocr_extract_3"), "ocr/extract")
  assert.equal(aliases.has("ocr_extract"), false)
})

test("an empty or missing map is a no-op", () => {
  assert.deepEqual(sanitizeToolMap({}), { tools: {}, aliases: new Map() })
  assert.deepEqual(sanitizeToolMap(undefined).tools, {})
})
