import { test } from "node:test"
import assert from "node:assert/strict"

import { formatSearchResult, formatReplaceResult, getEmptyResultHint } from "./format.mjs"

function match(file, line, text, replacement) {
  return {
    file,
    text,
    range: { start: { line, column: 0 }, end: { line, column: 0 } },
    ...(replacement !== undefined ? { replacement } : {}),
  }
}

test("formatSearchResult surfaces errors verbatim", () => {
  assert.equal(formatSearchResult({ matches: [], totalMatches: 0, error: "boom" }), "Error: boom")
})

test("formatSearchResult reports no matches", () => {
  assert.equal(formatSearchResult({ matches: [], totalMatches: 0 }), "No matches found.")
})

test("formatSearchResult groups matches by file, 1-indexes lines, escapes newlines", () => {
  const out = formatSearchResult({
    matches: [match("a.ts", 0, "foo()"), match("a.ts", 4, "bar()"), match("b.ts", 1, "x\ny")],
    totalMatches: 3,
  })
  assert.match(out, /a\.ts:/)
  assert.match(out, /\n {2}1: foo\(\)/)
  assert.match(out, /\n {2}5: bar\(\)/)
  assert.match(out, /x\\ny/) // newline escaped
  assert.match(out, /Found 3 matches in 2 files/)
})

test("formatSearchResult truncates long match text and notes truncation", () => {
  const long = "z".repeat(200)
  const out = formatSearchResult({
    matches: [match("a.ts", 0, long)],
    totalMatches: 5,
    truncated: true,
    truncatedReason: "match limit (100)",
  })
  assert.match(out, /z{100}\.\.\./)
  assert.match(out, /output truncated: match limit \(100\)/)
})

test("formatReplaceResult shows dry-run mode and a follow-up hint", () => {
  const out = formatReplaceResult(
    { matches: [match("a.ts", 0, "console.log(x)", "logger.info(x)")], totalMatches: 1 },
    true
  )
  assert.match(out, /\[DRY RUN\] would change 1 matches in 1 files/)
  assert.match(out, /console\.log\(x\) → logger\.info\(x\)/)
  assert.match(out, /Re-run with `dry_run: false`/)
})

test("formatReplaceResult shows applied mode without the dry-run hint", () => {
  const out = formatReplaceResult({ matches: [match("a.ts", 2, "a", "b")], totalMatches: 1 }, false)
  assert.match(out, /\[APPLIED\] changed 1 matches in 1 files/)
  assert.doesNotMatch(out, /Re-run with/)
})

test("formatReplaceResult handles errors, empty, missing replacement, truncation", () => {
  assert.equal(formatReplaceResult({ matches: [], totalMatches: 0, error: "x" }, true), "Error: x")
  assert.equal(
    formatReplaceResult({ matches: [], totalMatches: 0 }, true),
    "No matches found for replacement."
  )
  const noRepl = formatReplaceResult({ matches: [match("a.ts", 0, "a")], totalMatches: 1 }, true)
  assert.match(noRepl, /\[no replacement\]/)
  const longRepl = formatReplaceResult(
    {
      matches: [match("a.ts", 0, "o".repeat(80), "r".repeat(80))],
      totalMatches: 1,
      truncated: true,
      truncatedReason: "output size",
    },
    false
  )
  assert.match(longRepl, /o{60}\.\.\./)
  assert.match(longRepl, /r{60}\.\.\./)
  assert.match(longRepl, /output truncated: output size/)
})

test("getEmptyResultHint catches the trailing-colon python mistake", () => {
  assert.match(getEmptyResultHint("def $F($$$):", "python"), /Remove the trailing colon/)
  assert.match(getEmptyResultHint("class $C:", "python"), /Remove the trailing colon/)
  assert.match(getEmptyResultHint("async def $F($$$):", "python"), /Remove the trailing colon/)
})

test("getEmptyResultHint catches bare JS/TS function patterns", () => {
  assert.match(getEmptyResultHint("function $NAME", "typescript"), /need params and body/)
  assert.match(
    getEmptyResultHint("export async function $FN", "javascript"),
    /need params and body/
  )
})

test("getEmptyResultHint returns null when nothing obvious is wrong", () => {
  assert.equal(getEmptyResultHint("console.log($MSG)", "typescript"), null)
  assert.equal(getEmptyResultHint("foo", "rust"), null)
  assert.equal(getEmptyResultHint("def $F($$$)", "python"), null)
})
