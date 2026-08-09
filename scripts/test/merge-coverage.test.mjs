/**
 * Regression coverage for scripts/test/merge-coverage.mjs — the sharded-CI
 * coverage merge + threshold gate.
 *
 * Run with: node --test scripts/test/merge-coverage.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import libCoverage from "istanbul-lib-coverage"

import {
  parseArgs,
  resolveInput,
  mergeCoverageFiles,
  filterCollectedSources,
  checkGroup,
  classifyFiles,
  checkThresholds,
  writeReports,
} from "./merge-coverage.mjs"

/**
 * Minimal istanbul file-coverage entry: `total` statements of which the first
 * `covered` were hit. One function + one branch, both covered, keep the other
 * metrics green unless a test wants them.
 */
function fileCov(filePath, covered, total) {
  const statementMap = {}
  const s = {}
  for (let i = 0; i < total; i += 1) {
    statementMap[i] = {
      start: { line: i + 1, column: 0 },
      end: { line: i + 1, column: 10 },
    }
    s[i] = i < covered ? 1 : 0
  }
  return {
    [filePath]: {
      path: filePath,
      statementMap,
      s,
      fnMap: {
        0: {
          name: "f",
          decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
          loc: { start: { line: 1, column: 0 }, end: { line: total, column: 0 } },
        },
      },
      f: { 0: 1 },
      branchMap: {
        0: {
          loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
          type: "if",
          locations: [
            { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
            { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
          ],
        },
      },
      b: { 0: [1, 1] },
    },
  }
}

/** A fixture repo on disk (glob groups expand against the filesystem). */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "merge-cov-"))
  mkdirSync(join(root, "stores"), { recursive: true })
  mkdirSync(join(root, "lib"), { recursive: true })
  mkdirSync(join(root, "app"), { recursive: true })
  writeFileSync(join(root, "stores", "good.ts"), "")
  writeFileSync(join(root, "stores", "bad.ts"), "")
  writeFileSync(join(root, "lib", "util.ts"), "")
  writeFileSync(join(root, "app", "page.tsx"), "")
  return root
}

test("parseArgs handles flags and rejects bad input", () => {
  assert.deepEqual(parseArgs(["--check", "--out", "cov", "a.json", "b/"]), {
    check: true,
    out: "cov",
    inputs: ["a.json", "b/"],
  })
  assert.throws(() => parseArgs(["a.json", "--wat"]), /unknown option/i)
  assert.throws(() => parseArgs(["--check"]), /No coverage inputs/)
  assert.throws(() => parseArgs(["--out"]), /argument missing/i)
})

test("resolveInput maps directories to their coverage-final.json", () => {
  const root = makeRepo()
  assert.equal(resolveInput(root), join(root, "coverage-final.json"))
  assert.equal(resolveInput("x/coverage-final.json"), "x/coverage-final.json")
  rmSync(root, { recursive: true, force: true })
})

test("mergeCoverageFiles unions files and sums hit counts", () => {
  const root = makeRepo()
  const f1 = join(root, "s1.json")
  const f2 = join(root, "s2.json")
  // Shard 1 covers statements 0-1 of util.ts; shard 2 covers 0-3.
  writeFileSync(f1, JSON.stringify(fileCov(join(root, "lib", "util.ts"), 2, 4)))
  writeFileSync(
    f2,
    JSON.stringify({
      ...fileCov(join(root, "lib", "util.ts"), 4, 4),
      ...fileCov(join(root, "app", "page.tsx"), 1, 1),
    })
  )
  const map = mergeCoverageFiles([f1, f2])
  assert.equal(map.files().length, 2)
  const summary = map.fileCoverageFor(join(root, "lib", "util.ts")).toSummary()
  assert.equal(summary.statements.pct, 100) // union: shard 2 covered everything
  rmSync(root, { recursive: true, force: true })
})

test("filterCollectedSources applies Jest source globs and path ignores exactly", () => {
  const root = makeRepo()
  mkdirSync(join(root, "scripts"), { recursive: true })
  mkdirSync(join(root, "components", "ui"), { recursive: true })
  mkdirSync(join(root, "lib", "wiki"), { recursive: true })
  writeFileSync(join(root, "lib", "util.test.ts"), "")
  writeFileSync(join(root, "lib", "wiki", "types.ts"), "")
  writeFileSync(join(root, "scripts", "build.ts"), "")
  writeFileSync(join(root, "components", "ui", "button.tsx"), "")
  const map = libCoverage.createCoverageMap({
    ...fileCov(join(root, "lib", "util.ts"), 1, 1),
    ...fileCov(join(root, "lib", "util.test.ts"), 1, 1),
    ...fileCov(join(root, "lib", "wiki", "types.ts"), 1, 1),
    ...fileCov(join(root, "scripts", "build.ts"), 1, 1),
    ...fileCov(join(root, "components", "ui", "button.tsx"), 1, 1),
  })
  filterCollectedSources(map, { cwd: root })
  assert.deepEqual(map.files(), [join(root, "lib", "util.ts")])
  rmSync(root, { recursive: true, force: true })
})

test("coverage source manifest stays synchronized with Jest", () => {
  const jestConfig = readFileSync(new URL("../../jest.config.ts", import.meta.url), "utf8")
  const manifest = JSON.parse(
    readFileSync(new URL("./coverage-sources.json", import.meta.url), "utf8")
  )
  const collectionStart = jestConfig.indexOf("  collectCoverageFrom: [")
  const collectionEnd = jestConfig.indexOf("\n  ],\n\n  // The directory", collectionStart)
  const collectionBlock = jestConfig.slice(collectionStart, collectionEnd)
  const configuredSources = Array.from(
    collectionBlock.matchAll(/^\s+"([^"]+)"(?:,|$)/gm),
    (match) => match[1]
  )
  assert.deepEqual(manifest.collectCoverageFrom, configuredSources)

  const ignoreStart = jestConfig.indexOf("  coveragePathIgnorePatterns: [")
  const ignoreEnd = jestConfig.indexOf("\n  ],", ignoreStart)
  const ignoreBlock = jestConfig.slice(ignoreStart, ignoreEnd)
  const configuredIgnores = Array.from(
    ignoreBlock.matchAll(/^\s+"([^"]+)"(?:,|$)/gm),
    (match) => match[1]
  )
  assert.deepEqual(manifest.coveragePathIgnorePatterns, configuredIgnores)
})

test("checkGroup enforces percent and negative (max-uncovered) thresholds", () => {
  const map = libCoverage.createCoverageMap(fileCov("/x/a.ts", 3, 4)) // 75% stmts
  const summary = map.fileCoverageFor("/x/a.ts").toSummary()
  assert.deepEqual(checkGroup("g", { statements: 75 }, summary), [])
  assert.match(checkGroup("g", { statements: 80 }, summary)[0], /statements \(75%\).*"g".*80%/)
  // 1 uncovered statement: -1 allowed passes, 0 allowed fails.
  assert.deepEqual(checkGroup("g", { statements: -1 }, summary), [])
  assert.match(checkGroup("g", { statements: -0.5 }, summary)[0], /uncovered count/)
})

test("classifyFiles mirrors Jest: path prefix, glob, global remainder", () => {
  const root = makeRepo()
  const files = [
    join(root, "stores", "good.ts"),
    join(root, "lib", "util.ts"),
    join(root, "app", "page.tsx"),
  ]
  const groups = ["./stores/**/*.{ts,tsx}", "./lib/", "global"]
  const { byGroup, groupType } = classifyFiles(files, groups, { cwd: root })
  assert.equal(groupType.get("./stores/**/*.{ts,tsx}"), "glob")
  assert.equal(groupType.get("./lib/"), "path")
  assert.equal(groupType.get("global"), "global")
  assert.deepEqual(byGroup.get("./stores/**/*.{ts,tsx}"), [join(root, "stores", "good.ts")])
  assert.deepEqual(byGroup.get("./lib/"), [join(root, "lib", "util.ts")])
  assert.deepEqual(byGroup.get("global"), [join(root, "app", "page.tsx")])
  rmSync(root, { recursive: true, force: true })
})

test("checkThresholds: glob groups gate per file, not on the aggregate", () => {
  const root = makeRepo()
  const map = libCoverage.createCoverageMap({
    ...fileCov(join(root, "stores", "good.ts"), 10, 10), // 100%
    ...fileCov(join(root, "stores", "bad.ts"), 8, 10), // 80% — below 90
    ...fileCov(join(root, "app", "page.tsx"), 1, 1),
  })
  const thresholds = {
    "./stores/**/*.{ts,tsx}": { statements: 90 },
    global: { statements: 50 },
  }
  const errors = checkThresholds(map, thresholds, { cwd: root })
  // Aggregate would be 18/20 = 90% and pass; per-file semantics must fail bad.ts.
  assert.equal(errors.length, 1)
  assert.match(errors[0], /statements \(80%\).*bad\.ts/)
  rmSync(root, { recursive: true, force: true })
})

test("checkThresholds errors when a configured group has no coverage data", () => {
  const root = makeRepo()
  const map = libCoverage.createCoverageMap(fileCov(join(root, "app", "page.tsx"), 1, 1))
  const errors = checkThresholds(
    map,
    { "./stores/**/*.{ts,tsx}": { statements: 90 }, global: { statements: 50 } },
    { cwd: root }
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Coverage data for \.\/stores\/\*\*\/\*\.\{ts,tsx\} was not found/)
  rmSync(root, { recursive: true, force: true })
})

test("checkThresholds passes a fully green map", () => {
  const root = makeRepo()
  const map = libCoverage.createCoverageMap({
    ...fileCov(join(root, "stores", "good.ts"), 10, 10),
    ...fileCov(join(root, "app", "page.tsx"), 1, 1),
  })
  const errors = checkThresholds(
    map,
    { "./stores/**/*.{ts,tsx}": { statements: 90 }, global: { statements: 50 } },
    { cwd: root }
  )
  assert.deepEqual(errors, [])
  rmSync(root, { recursive: true, force: true })
})

test("writeReports emits merged json + lcov info + html report", () => {
  const root = makeRepo()
  const map = libCoverage.createCoverageMap(fileCov(join(root, "lib", "util.ts"), 2, 4))
  const out = join(root, "coverage")
  writeReports(map, out)
  assert.ok(existsSync(join(out, "coverage-final.json")))
  assert.ok(existsSync(join(out, "lcov.info")))
  assert.ok(existsSync(join(out, "lcov-report", "index.html")))
  rmSync(root, { recursive: true, force: true })
})
