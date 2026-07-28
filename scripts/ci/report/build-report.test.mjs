/**
 * Coverage for scripts/ci/report/build-report.mjs.
 *
 * The behaviour under test is tolerance: every input is optional and the
 * report must still assemble. A run whose e2e job was skipped, or whose trunk
 * branch has no successful run to diff against, is exactly when someone needs
 * to read the report.
 *
 * Run with: node --test scripts/ci/report/build-report.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FLAGS, assemble, parseArgs, readJUnitDocuments, readJsonOrNull } from "./build-report.mjs"

const JUNIT = `<testsuites><testsuite name="s">
  <testcase classname="lib/a.test.ts" name="ok" time="1"/>
</testsuite></testsuites>`

function istanbul(path, count, hit) {
  const statementMap = {}
  const s = {}
  for (let i = 0; i < count; i += 1) {
    statementMap[i] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 1 } }
    s[i] = i < hit ? 1 : 0
  }
  return { [path]: { path, statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} } }
}

test("parseArgs reads every documented flag", () => {
  const args = parseArgs(["--jest-dir", "a", "--sha", "deadbeef", "--out", "r.md"])
  assert.equal(args["jest-dir"], "a")
  assert.equal(args.sha, "deadbeef")
  assert.equal(args.out, "r.md")
  assert.ok(FLAGS.includes("base-bundle"))
  assert.ok(FLAGS.includes("base-playwright-json"))
})

test("parseArgs rejects unknown flags and missing values", () => {
  assert.throws(() => parseArgs(["--nope", "x"]), /Unknown flag/)
  assert.throws(() => parseArgs(["--sha"]), /requires a value/)
  assert.throws(() => parseArgs(["positional"]), /Unexpected argument/)
})

test("readJsonOrNull returns null for a missing path, bad JSON, or no path", () => {
  assert.equal(readJsonOrNull(undefined), null)
  assert.equal(readJsonOrNull("/definitely/not/here.json"), null)
  assert.equal(
    readJsonOrNull("x", () => "{not json"),
    null
  )
  assert.deepEqual(
    readJsonOrNull("x", () => '{"a":1}'),
    { a: 1 }
  )
})

test("readJUnitDocuments walks per-shard subdirectories and keeps only .xml", () => {
  const root = mkdtempSync(join(tmpdir(), "junit-"))
  mkdirSync(join(root, "jest-shard-1"), { recursive: true })
  mkdirSync(join(root, "jest-shard-2"), { recursive: true })
  writeFileSync(join(root, "jest-shard-1", "junit-shard-1.xml"), JUNIT)
  writeFileSync(join(root, "jest-shard-2", "junit-shard-2.xml"), JUNIT)
  writeFileSync(join(root, "jest-shard-2", "coverage-final.json"), "{}")

  assert.equal(readJUnitDocuments(root).length, 2)
})

test("readJUnitDocuments returns nothing when the directory is absent", () => {
  assert.deepEqual(readJUnitDocuments("/definitely/not/here"), [])
  assert.deepEqual(readJUnitDocuments(undefined), [])
})

test("assemble omits sections whose inputs are missing", () => {
  const data = assemble({ junitDocs: [], meta: { sha: "abc" } })
  assert.equal(data.jest, undefined)
  assert.equal(data.playwright, undefined)
  assert.equal(data.coverage, undefined)
  assert.equal(data.bundle, undefined)
  assert.deepEqual(data.meta, { sha: "abc" })
})

test("assemble summarizes jest when shard documents are present", () => {
  const data = assemble({ junitDocs: [JUNIT] })
  assert.equal(data.jest.total, 1)
  assert.equal(data.jest.passed, 1)
})

test("assemble compares Playwright health with the trunk baseline", () => {
  const report = {
    suites: [
      {
        specs: [
          {
            title: "works",
            tests: [
              {
                status: "expected",
                results: [{ status: "passed", duration: 1000 }],
              },
            ],
          },
        ],
      },
    ],
  }
  const data = assemble({
    junitDocs: [],
    playwrightJson: report,
    basePlaywrightJson: report,
  })

  assert.equal(data.playwright.trend.hasBase, true)
  assert.equal(data.playwright.trend.metrics.length, 3)
})

test("assemble diffs coverage against the base when both sides exist", () => {
  const data = assemble({
    junitDocs: [],
    coverage: istanbul("/repo/a.ts", 10, 8),
    baseCoverage: istanbul("/repo/a.ts", 10, 5),
  })
  assert.equal(data.coverage.hasBase, true)
  const statements = data.coverage.metrics.find((m) => m.key === "statements")
  assert.equal(statements.delta, 30)
})

test("assemble reports coverage without a base rather than skipping it", () => {
  const data = assemble({ junitDocs: [], coverage: istanbul("/repo/a.ts", 4, 2) })
  assert.equal(data.coverage.hasBase, false)
  assert.equal(data.coverage.current.metrics.statements.pct, 50)
})

test("assemble diffs the bundle when both measurements exist", () => {
  const data = assemble({
    junitDocs: [],
    bundle: { totalBytes: 200, jsBytes: 100, cssBytes: 0, htmlBytes: 0, fileCount: 2 },
    baseBundle: { totalBytes: 100, jsBytes: 50, cssBytes: 0, htmlBytes: 0, fileCount: 1 },
  })
  assert.equal(data.bundle.hasBase, true)
  assert.equal(data.bundle.metrics.find((m) => m.key === "totalBytes").delta, 100)
})
