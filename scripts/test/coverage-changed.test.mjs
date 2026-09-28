/**
 * Regression coverage for scripts/test/coverage-changed.mjs — the scoped
 * changed-files coverage runner behind `pnpm test:coverage:changed`.
 *
 * Run with: node --test scripts/test/coverage-changed.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { readFileSync } from "node:fs"
import libCoverage from "istanbul-lib-coverage"
import ts from "typescript"
import { parse as parseYaml } from "yaml"
import { filterCollectedSources } from "./merge-coverage.mjs"

import {
  parseArgs,
  filterCoverageTargets,
  buildJestArgs,
  listChangedFiles,
  checkChangedCoverage,
} from "./coverage-changed.mjs"

test("parseArgs defaults, overrides, and rejects unknown flags", () => {
  // origin/dev, not master: master is ~1500 commits behind this repo's real
  // trunk, so defaulting to it made "changed files" mean "most of the repo".
  assert.deepEqual(parseArgs([]), { base: "origin/dev", strict: false })
  assert.deepEqual(parseArgs(["--base", "dev", "--strict"]), { base: "dev", strict: true })
  assert.throws(() => parseArgs(["--nope"]), /unknown option/i)
  assert.throws(() => parseArgs(["--base"]), /argument missing/i)
  assert.equal(
    parseArgs(["--coverage-map", "coverage/coverage-final.json"]).coverageMap,
    "coverage/coverage-final.json"
  )
})

test("merged coverage enforces the same per-file floors and rejects missing data", () => {
  const filename = path.resolve("lib/coverage-fixture.ts")
  const map = libCoverage.createCoverageMap({
    [filename]: {
      path: filename,
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
      fnMap: {},
      branchMap: {},
      s: { 0: 1 },
      f: {},
      b: {},
    },
  })
  assert.deepEqual(checkChangedCoverage(map, ["lib/coverage-fixture.ts"], { strict: true }), [])
  map.fileCoverageFor(filename).data.s[0] = 0
  assert.ok(
    checkChangedCoverage(map, ["lib/coverage-fixture.ts"], { strict: true }).some((error) =>
      error.includes("90%")
    )
  )
  assert.ok(
    checkChangedCoverage(map, ["lib/missing.ts"], { strict: true }).some((error) =>
      error.includes("not found")
    )
  )
  assert.deepEqual(checkChangedCoverage(map, ["lib/coverage-fixture.ts"]), [])
})

test("changed files cannot borrow coverage from a file with a matching path prefix", () => {
  const filename = path.resolve("lib/exact.ts")
  const neighbor = `${filename}x`
  const map = libCoverage.createCoverageMap({})
  for (const [file, count, hit] of [
    [filename, 1, 0],
    [neighbor, 10, 1],
  ]) {
    const statementMap = {},
      s = {}
    for (let index = 0; index < count; index++) {
      statementMap[index] = {
        start: { line: index + 1, column: 0 },
        end: { line: index + 1, column: 1 },
      }
      s[index] = hit
    }
    map.addFileCoverage({ path: file, statementMap, fnMap: {}, branchMap: {}, s, f: {}, b: {} })
  }
  assert.ok(
    checkChangedCoverage(map, ["lib/exact.ts"], { strict: true }).some((error) =>
      error.includes("(0%)")
    )
  )
  map.filter((file) => file !== filename)
  assert.deepEqual(checkChangedCoverage(map, ["lib/exact.ts"], { strict: true }), [
    "Coverage data for ./lib/exact.ts was not found.",
  ])
})

test("strict merged checks retain function and branch floors as well as lines", () => {
  const filename = path.resolve("lib/metrics.ts")
  const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }
  const map = libCoverage.createCoverageMap({
    [filename]: {
      path: filename,
      statementMap: { 0: loc },
      fnMap: { 0: { name: "fn", decl: loc, loc, line: 1 } },
      branchMap: { 0: { type: "if", line: 1, loc, locations: [loc, loc] } },
      s: { 0: 1 },
      f: { 0: 0 },
      b: { 0: [1, 0] },
    },
  })
  const errors = checkChangedCoverage(map, ["lib/metrics.ts"], { strict: true })
  assert.equal(errors.length, 2)
  assert.ok(errors.some((error) => error.includes("functions (0%)")))
  assert.ok(errors.some((error) => error.includes("branches (50%)")))
})

test("moved runtime obligations exist in the complete map while type-only and test drivers do not", () => {
  const runtime = [
    "packages/agent-config-types/src/claude-agent-sdk-options.ts",
    "packages/agent-config-types/src/runtime-versions.ts",
    "packages/companion-client/src/browser-enrollment-payload.ts",
    "packages/companion-client/src/session.ts",
    "packages/plugin-ui/src/live-query.ts",
    "packages/provider-types/src/provider.ts",
  ]
  const excluded = [
    "lib/claude/agents/subagents/types.ts",
    "packages/agent-config-types/src/lsp-config.ts",
    "cli/src/tui/pty/tui-app-fixture.tsx",
  ]
  assert.deepEqual(filterCoverageTargets([...runtime, ...excluded]), runtime)
  const map = libCoverage.createCoverageMap({})
  for (const file of [...runtime, ...excluded]) {
    map.addFileCoverage({
      path: path.resolve(file),
      statementMap: {},
      fnMap: {},
      branchMap: {},
      s: {},
      f: {},
      b: {},
    })
  }
  filterCollectedSources(map)
  assert.deepEqual(map.files().sort(), runtime.map((file) => path.resolve(file)).sort())
})

test("the exact type-only exclusions cannot acquire runtime statements silently", () => {
  const emittedRuntime = (source) =>
    ts
      .transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
          removeComments: true,
        },
      })
      .outputText.trim()
      .replace(/^export\s*\{\s*\};?$/, "")
  for (const file of [
    "lib/claude/agents/subagents/types.ts",
    "packages/agent-config-types/src/lsp-config.ts",
  ]) {
    assert.equal(
      emittedRuntime(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")),
      "",
      `${file} now contains runtime code; collect it instead of retaining the type-only exemption`
    )
  }
  assert.notEqual(emittedRuntime("export const requiredAtRuntime = true"), "")
  assert.notEqual(emittedRuntime('import "./side-effect"; export interface Contract {}'), "")
})

test("CI changed coverage consumes only a successful complete merge", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8")
  )
  const changed = workflow.jobs["coverage-changed"]
  assert.ok(changed.needs.includes("test"))
  assert.ok(changed.needs.includes("coverage-merge"))
  assert.match(changed.if, /needs\.test\.result == 'success'/)
  const download = changed.steps.findIndex(
    (step) =>
      step.uses?.startsWith("actions/download-artifact@") && step.with?.name === "coverage-report"
  )
  const check = changed.steps.findIndex((step) =>
    step.run?.includes("scripts/test/coverage-changed.mjs")
  )
  assert.ok(download >= 0 && check > download)
  assert.match(changed.steps[check].run, /--strict/)
  assert.match(changed.steps[check].run, /--coverage-map coverage\/coverage-final\.json/)
  assert.ok(
    workflow.jobs["coverage-merge"].steps.some(
      (step) =>
        step.run?.includes("merge-coverage.mjs --check") &&
        step.if === "needs.test.result == 'success'"
    )
  )
})

test("filterCoverageTargets keeps collected sources only", () => {
  const files = [
    "lib/goal/engine.ts", // collected
    "components/goal/goal-card.tsx", // collected
    "components/ui/button.tsx", // excluded dir
    "components/ai-elements/message.tsx", // excluded dir
    "lib/goal/engine.test.ts", // test file
    "components/goal/goal-card.stories.tsx", // storybook
    "stores/pet/pet-store.ts", // collected
    "cli/src/tui/app.ts", // collected
    "packages/rag/src/chunker.ts", // collected
    "packages/rag/scripts/gen.ts", // not under src/
    "src-tauri/src/lib.rs", // not a TS root
    "docs/app/page.tsx", // not collected root
    "i18n/messages/en.json", // not source ext
    "hooks/use-ocr.ts", // collected
  ]
  assert.deepEqual(filterCoverageTargets(files), [
    "lib/goal/engine.ts",
    "components/goal/goal-card.tsx",
    "stores/pet/pet-store.ts",
    "cli/src/tui/app.ts",
    "packages/rag/src/chunker.ts",
    "hooks/use-ocr.ts",
  ])
})

test("buildJestArgs narrows coverage and disables config thresholds by default", () => {
  const args = buildJestArgs(["lib/a.ts", "lib/b.tsx"])
  assert.deepEqual(args, [
    "--coverage",
    "--collectCoverageFrom={lib/a.ts,lib/b.tsx}",
    "--coverageThreshold={}",
    "--findRelatedTests",
    "lib/a.ts",
    "lib/b.tsx",
  ])
})

test("buildJestArgs passes a single file verbatim (no one-entry brace group)", () => {
  const args = buildJestArgs(["lib/a.ts"])
  assert.equal(args[1], "--collectCoverageFrom=lib/a.ts")
})

test("buildJestArgs --strict applies the 90% bar to every changed file", () => {
  const args = buildJestArgs(["lib/a.ts", "hooks/use-b.ts"], { strict: true })
  const thresholdArg = args.find((a) => a.startsWith("--coverageThreshold="))
  assert.deepEqual(JSON.parse(thresholdArg.split("=").slice(1).join("=")), {
    "./lib/a.ts": { branches: 90, functions: 90, lines: 90, statements: 90 },
    "./hooks/use-b.ts": { branches: 90, functions: 90, lines: 90, statements: 90 },
  })
})

test("listChangedFiles merges diff + untracked, dedupes, drops blanks", () => {
  const calls = []
  const fakeExec = (cmd, cmdArgs) => {
    calls.push([cmd, ...cmdArgs])
    if (cmdArgs[0] === "merge-base") return "abc123\n"
    if (cmdArgs[0] === "diff") return "lib/a.ts\nlib/b.ts\n\n"
    if (cmdArgs[0] === "ls-files") return "lib/b.ts\nlib/new.ts\n"
    throw new Error(`unexpected git call: ${cmdArgs.join(" ")}`)
  }
  const files = listChangedFiles("master", fakeExec)
  assert.deepEqual(files, ["lib/a.ts", "lib/b.ts", "lib/new.ts"])
  assert.deepEqual(calls[0], ["git", "merge-base", "HEAD", "master"])
  assert.deepEqual(calls[1], ["git", "diff", "--name-only", "--diff-filter=d", "abc123"])
})
