import { test } from "node:test"
import assert from "node:assert/strict"
import { formatDiagnostics, countDiagnostics } from "./report.mjs"

const ERR = {
  range: { start: { line: 11, character: 4 } },
  severity: 1,
  message: "Cannot find name 'bar'.",
  source: "ts",
}
const WARN = {
  range: { start: { line: 19, character: 0 } },
  severity: 2,
  message: "'baz' is declared but never read.",
  source: "ts",
}
const INFO = { range: { start: { line: 0, character: 0 } }, severity: 3, message: "info" }

test("formats errors + warnings with 1-based line/col and header", () => {
  const out = formatDiagnostics("src/foo.ts", [ERR, WARN])
  assert.equal(
    out,
    "src/foo.ts\n  12:5 ERROR Cannot find name 'bar'. [ts]\n  20:1 WARN 'baz' is declared but never read. [ts]"
  )
})

test("minSeverity filters out info/hint by default", () => {
  const out = formatDiagnostics("a.ts", [INFO])
  assert.equal(out, null)
})

test("includeHeader=false omits the file header", () => {
  const out = formatDiagnostics("a.ts", [ERR], { includeHeader: false })
  assert.equal(out, "  12:5 ERROR Cannot find name 'bar'. [ts]")
})

test("returns null for empty / non-array input", () => {
  assert.equal(formatDiagnostics("a.ts", []), null)
  assert.equal(formatDiagnostics("a.ts", undefined), null)
})

test("missing source renders no bracket", () => {
  const out = formatDiagnostics("a.ts", [{ range: { start: {} }, severity: 1, message: "boom" }])
  assert.equal(out, "a.ts\n  1:1 ERROR boom")
})

test("countDiagnostics respects minSeverity", () => {
  assert.equal(countDiagnostics([ERR, WARN, INFO]), 2)
  assert.equal(countDiagnostics([ERR, WARN, INFO], 3), 3)
  assert.equal(countDiagnostics([], 1), 0)
})
