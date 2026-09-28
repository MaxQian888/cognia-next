/**
 * Regression coverage for scripts/test/coverage-changed.mjs — the scoped
 * changed-files coverage runner behind `pnpm test:coverage:changed`.
 *
 * Run with: node --test scripts/test/coverage-changed.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { readFileSync, mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs"
import os from "node:os"
import { execaSync } from "execa"
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
  buildIncrementalTestPlan,
  listCommittedChanges,
  buildPlannedJestArgs,
  classifyCiImpact,
  findDeletedModuleConsumers,
  runPlannedShard,
} from "./coverage-changed.mjs"

test("deleted-module discovery keeps old consumers outside the removed module's directory", () => {
  const calls = []
  const consumers = findDeletedModuleConsumers(
    ["lib/old.ts", "packages/contracts/src/index.ts"],
    "base-sha",
    (_command, args) => {
      calls.push(args)
      return "base-sha:components/chat/consumer.tsx\0base-sha:lib/other.test.ts\0"
    }
  )
  assert.deepEqual(consumers, ["components/chat/consumer.tsx", "lib/other.test.ts"])
  assert.ok(calls[0].includes('/old"'))
  assert.ok(calls[0].includes('"old"'))
  assert.ok(calls[0].includes("/old.js'"))
  assert.ok(calls[0].includes('/src"'))
  assert.ok(calls[0].includes('/contracts"'))
  assert.ok(calls[0].includes("base-sha"))
  assert.deepEqual(
    findDeletedModuleConsumers(["lib/old.test.ts"], "base-sha", () => {
      throw new Error("unexpected grep")
    }),
    []
  )
})

test("committed planning follows surviving importers of a moved module in a real Git/Jest graph", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cognia-planner-move-"))
  const script = path.resolve("scripts/test/coverage-changed.mjs")
  const git = (...args) => execaSync("git", args, { cwd: directory }).stdout.trim()
  try {
    git("init", "--quiet")
    git("config", "user.email", "fixture@example.invalid")
    git("config", "user.name", "Planner fixture")
    writeFileSync(
      path.join(directory, "jest.config.cjs"),
      'module.exports = { testEnvironment: "node", testMatch: ["**/*.test.js"] }'
    )
    writeFileSync(path.join(directory, "old.js"), "module.exports = 1")
    writeFileSync(path.join(directory, "consumer.js"), 'module.exports = require("./old")')
    writeFileSync(
      path.join(directory, "consumer.test.js"),
      'const value = require("./consumer"); test("value", () => expect(value).toBe(1))'
    )
    writeFileSync(
      path.join(directory, "unrelated.test.js"),
      'test("other", () => expect(true).toBe(true))'
    )
    git("add", ".")
    git("commit", "--quiet", "-m", "base fixture")
    const base = git("rev-parse", "HEAD")
    renameSync(path.join(directory, "old.js"), path.join(directory, "moved.js"))
    git("add", ".")
    git("commit", "--quiet", "-m", "move module without updating consumer")
    const head = git("rev-parse", "HEAD")
    symlinkSync(path.resolve("node_modules"), path.join(directory, "node_modules"), "dir")
    const result = execaSync(process.execPath, [script, "--plan", "--base", base, "--head", head], {
      cwd: directory,
    })
    const plan = JSON.parse(result.stdout)
    assert.equal(plan.head, head)
    assert.deepEqual(plan.deletedFiles, ["old.js"])
    assert.deepEqual(plan.deletedConsumers, ["consumer.js"])
    assert.ok(plan.testFiles.includes("consumer.test.js"))
    assert.ok(
      plan.selectionReasons
        .find((reason) => reason.kind === "related")
        .testFiles.includes("consumer.test.js")
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("CI impact distinguishes an ordinary UI edit from native and independent workspace work", () => {
  const ui = classifyCiImpact(["components/chat/message.tsx"])
  assert.equal(ui.frontend, true)
  for (const key of [
    "rust",
    "productionBuild",
    "mobile",
    "docs",
    "web",
    "browserExtension",
    "postgres",
    "diagnostic",
  ])
    assert.equal(ui[key], false, key)
  const docs = classifyCiImpact(["docs/app/page.tsx"])
  assert.equal(docs.docs, true)
  assert.equal(docs.frontend, false)
  const diagnostic = classifyCiImpact(["services/diagnostic-server/Cargo.toml"])
  assert.equal(diagnostic.diagnostic, true)
  for (const key of ["globalRust", "rust", "gateway", "postgres", "productionBuild"])
    assert.equal(diagnostic[key], false, key)
  for (const file of [
    "lib/platform/client.mobile.ts",
    "components/shell.mobile.tsx",
    "lib/capacitor/native.ts",
    "next.config.ts",
  ])
    assert.equal(classifyCiImpact([file]).mobile, true, file)
  for (const file of ["tests/e2e/browser-extension/popup.spec.ts", "playwright.config.ts"])
    assert.equal(classifyCiImpact([file]).browserExtension, true, file)
  const packageChange = classifyCiImpact(["packages/agent/src/index.ts"])
  assert.equal(packageChange.gateway, true)
  assert.equal(packageChange.browserExtension, true)
})

test("shared manifests, Rust graph and workflow changes conservatively fan out their runtime checks", () => {
  const js = classifyCiImpact(["pnpm-lock.yaml"])
  for (const key of [
    "globalJS",
    "frontend",
    "sidecar",
    "docs",
    "web",
    "mobile",
    "browserExtension",
    "gateway",
    "productionBuild",
  ])
    assert.equal(js[key], true, key)
  assert.equal(js.rust, false)
  const rust = classifyCiImpact(["Cargo.lock"])
  for (const key of ["globalRust", "rust", "gateway", "postgres", "productionBuild"])
    assert.equal(rust[key], true, key)
  assert.equal(rust.diagnostic, false)
  assert.equal(rust.frontend, false)
  assert.ok(Object.values(classifyCiImpact([".github/workflows/test.yml"])).every(Boolean))
  assert.ok(Object.values(classifyCiImpact([], "full")).every(Boolean))
})

test("embedded native inputs and shared tenant auth activate their consumers", () => {
  for (const file of [
    ".cargo/config.toml",
    "cli/src/x/agent-launcher.ts",
    "hooks/builtin-hooks.lockstep.json",
    "hooks/matcher-conformance.json",
    "cli/src/serve/fixtures/bridge-frames.json",
  ]) {
    const impact = classifyCiImpact([file])
    assert.equal(impact.rust, true, file)
    assert.equal(impact.productionBuild, true, file)
  }
  assert.equal(classifyCiImpact(["crates/cognia-tenant-auth/src/lib.rs"]).postgres, true)
  assert.equal(classifyCiImpact(["tests/conformance/harness.ts"]).gateway, true)
  assert.equal(classifyCiImpact([".cargo/config.toml"]).diagnostic, true)
  assert.ok(Object.values(classifyCiImpact(["scripts/test/coverage-changed.mjs"])).every(Boolean))
})

test("incremental plans retain direct, colocated, related, and deletion-neighbor suites exactly once", () => {
  const inventory = [
    "lib/a.test.ts",
    "lib/consumer.test.ts",
    "lib/gone-neighbor.test.ts",
    "other/b.test.ts",
  ]
  const plan = buildIncrementalTestPlan({
    base: "base",
    head: "head",
    mergeBase: "ancestor",
    changedFiles: ["lib/a.ts", "lib/a.test.ts", "lib/removed.ts"],
    deletedFiles: ["lib/removed.ts"],
    testFiles: inventory,
    relatedTests: ["lib/consumer.test.ts", "lib/a.test.ts"],
  })
  assert.deepEqual(plan.testFiles, inventory.slice(0, 3))
  assert.deepEqual(plan.shards.flatMap((shard) => shard.testFiles).sort(), plan.testFiles)
  assert.equal(plan.mode, "incremental")
  assert.deepEqual(plan.matrix, { include: [{ shard: 1, total: 1 }] })
})

test("unresolved removed modules fall back to their owning subtree without dropping suites", () => {
  const testFiles = [
    "lib/other/registry.test.ts",
    "packages/agent/src/contract.test.ts",
    "components/unrelated.test.tsx",
  ]
  const plan = buildIncrementalTestPlan({
    changedFiles: ["lib/runtime/removed.ts", "packages/agent/src/removed.ts"],
    deletedFiles: ["lib/runtime/removed.ts", "packages/agent/src/removed.ts"],
    unresolvedDeletedFiles: ["lib/runtime/removed.ts", "packages/agent/src/removed.ts"],
    testFiles,
  })
  assert.deepEqual(plan.testFiles, testFiles.slice(0, 2))
  assert.equal(
    plan.selectionReasons.filter((reason) => reason.kind === "deleted-owner-fallback").length,
    2
  )
  assert.deepEqual(
    buildIncrementalTestPlan({ unresolvedDeletedFiles: ["shared.ts"], testFiles }).testFiles,
    [...testFiles].sort()
  )
})

test("selection retains discovered __tests__ files and colocated module-extension variants", () => {
  const inventory = ["lib/__tests__/contract.ts", "lib/runtime.test.mts", "lib/loader.spec.cts"]
  const plan = buildIncrementalTestPlan({
    changedFiles: ["lib/__tests__/contract.ts", "lib/runtime.mts", "lib/loader.cts"],
    testFiles: inventory,
  })
  assert.deepEqual(plan.testFiles, [...inventory].sort())
})

test("dependency-only plans choose explicit critical suites and changed package contracts, not all tests", () => {
  const critical = "lib/db/messages.test.ts"
  const plan = buildIncrementalTestPlan({
    changedFiles: ["pnpm-lock.yaml", "packages/agent/package.json"],
    testFiles: [critical, "packages/agent/src/rpc.test.ts", "components/unrelated.test.tsx"],
  })
  assert.deepEqual(plan.testFiles, [critical, "packages/agent/src/rpc.test.ts"])
  assert.ok(plan.selectionReasons.some((reason) => reason.kind === "dependency-smoke"))
})

test("package patches affect every Jest suite while npm configuration exercises dependency contracts", () => {
  const inventory = ["lib/db/messages.test.ts", "lib/unrelated.test.ts"]
  const patch = "patches/@sinonjs__fake-timers@15.4.0.patch"
  assert.deepEqual(
    buildIncrementalTestPlan({ changedFiles: [patch], testFiles: inventory }).testFiles,
    inventory
  )
  assert.deepEqual(
    buildIncrementalTestPlan({ changedFiles: [".npmrc"], testFiles: inventory }).testFiles,
    [inventory[0]]
  )
  for (const file of [patch, ".npmrc"]) {
    const impact = classifyCiImpact([file])
    for (const key of [
      "globalJS",
      "frontend",
      "sidecar",
      "docs",
      "web",
      "mobile",
      "browserExtension",
      "gateway",
      "productionBuild",
    ])
      assert.equal(impact[key], true, `${file}: ${key}`)
    assert.equal(impact.rust, false)
  }
})

test("global Jest config selects every affected suite while docs-only changes launch no empty shards", () => {
  const inventory = ["lib/a.test.ts", "lib/b.test.ts"]
  const global = buildIncrementalTestPlan({
    changedFiles: ["jest.config.ts"],
    testFiles: inventory,
  })
  assert.deepEqual(global.testFiles, inventory)
  const docs = buildIncrementalTestPlan({ changedFiles: ["docs/guide.md"], testFiles: inventory })
  assert.deepEqual(docs.testFiles, [])
  assert.deepEqual(docs.matrix, { include: [] })
})

test("bounded plans distribute all selected suites without duplicate assignments or truncation", () => {
  const inventory = Array.from({ length: 1301 }, (_, index) => `lib/case-${index}.test.ts`)
  const plan = buildIncrementalTestPlan({ mode: "full", testFiles: inventory, maxShards: 8 })
  assert.equal(plan.shardCount, 8)
  assert.equal(plan.suiteCount, 1301)
  assert.deepEqual(plan.shards.flatMap((shard) => shard.testFiles).sort(), [...inventory].sort())
  assert.ok(plan.shards.every((shard) => shard.testFiles.length <= 163))
})

test("committed diffs use exact resolved refs and include both sides of a rename without local files", () => {
  const calls = []
  const exec = (_command, args) => {
    calls.push(args)
    if (args[0] === "rev-parse")
      return args.at(-1) === "base^{commit}" ? "base-sha\n" : "head-sha\n"
    if (args[0] === "merge-base") return "ancestor-sha\n"
    if (args[0] === "diff") return "D\0lib/old.ts\0A\0lib/new.ts\0M\0lib/space name.ts\0"
    throw new Error("unexpected command")
  }
  assert.deepEqual(listCommittedChanges("base", "head", exec), {
    base: "base-sha",
    head: "head-sha",
    mergeBase: "ancestor-sha",
    changedFiles: ["lib/new.ts", "lib/old.ts", "lib/space name.ts"],
    deletedFiles: ["lib/old.ts"],
  })
  assert.deepEqual(calls.at(-1), [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    "ancestor-sha",
    "head-sha",
    "--",
  ])
  assert.ok(!calls.some((args) => args[0] === "ls-files"))
})

test("plan execution uses exact paths and forbids coverage for incremental runs", () => {
  const plan = buildIncrementalTestPlan({
    changedFiles: ["lib/a.test.ts"],
    testFiles: ["lib/a.test.ts"],
  })
  const args = buildPlannedJestArgs(plan, 1)
  assert.ok(args.includes("--coverage=false"))
  assert.deepEqual(args.slice(-2), ["--runTestsByPath", "lib/a.test.ts"])
  assert.throws(() => buildPlannedJestArgs(plan, 1, { coverage: true }), /full mode/)
  assert.throws(() => buildPlannedJestArgs(plan, 2), /Unknown shard/)
  const full = buildIncrementalTestPlan({ mode: "full", testFiles: ["lib/a.test.ts"] })
  assert.ok(
    buildPlannedJestArgs(full, 1, { coverage: true }).includes("--coverageDirectory=coverage")
  )
  assert.throws(
    () =>
      buildPlannedJestArgs({ ...plan, testFiles: [...plan.testFiles, "lib/missing.test.ts"] }, 1),
    /missing or duplicate/
  )
  assert.throws(
    () => buildPlannedJestArgs({ ...plan, shards: [plan.shards[0], plan.shards[0]] }, 1),
    /missing or duplicate/
  )
})

test("incremental runner bounds process size, preserves failures and combines batch timings", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cognia-planner-batches-"))
  try {
    const inventory = Array.from({ length: 307 }, (_, index) => `lib/case-${index}.test.ts`)
    const plan = buildIncrementalTestPlan({
      changedFiles: ["jest.config.ts"],
      testFiles: inventory,
      maxShards: 1,
    })
    const calls = []
    const timingPath = path.join(directory, "jest-timings.json")
    const code = runPlannedShard(plan, 1, {
      env: { JEST_TIMING_OUTPUT: timingPath, JEST_JUNIT_OUTPUT_NAME: "junit-shard-1.xml" },
      run: (args, env) => {
        calls.push({ args, env })
        writeFileSync(
          env.JEST_TIMING_OUTPUT,
          JSON.stringify({
            version: 1,
            tests: {
              [`lib/batch-${calls.length}.test.ts`]: {
                durationMs: 100,
                updatedAt: "2026-09-28T00:00:00.000Z",
              },
            },
          })
        )
        return { exitCode: calls.length === 1 ? 1 : 0 }
      },
    })
    assert.equal(code, 1)
    assert.equal(calls.length, 3)
    const executed = calls.flatMap(({ args }) => args.slice(args.indexOf("--runTestsByPath") + 1))
    assert.deepEqual(executed.sort(), [...inventory].sort())
    assert.equal(new Set(executed).size, inventory.length)
    calls.forEach(({ args, env }, index) => {
      assert.ok(args.length - args.indexOf("--runTestsByPath") - 1 <= 150)
      assert.ok(args.includes("--coverage=false"))
      assert.equal(env.JEST_COVERAGE, "0")
      assert.equal(env.JEST_JUNIT_OUTPUT_NAME, `junit-shard-1-batch-${index + 1}.xml`)
    })
    assert.equal(Object.keys(JSON.parse(readFileSync(timingPath, "utf8")).tests).length, 3)
    assert.equal(runPlannedShard(plan, 1, { env: {}, run: () => ({ exitCode: null }) }), 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("full runner preserves a single coverage map and original reporting paths", () => {
  const plan = buildIncrementalTestPlan({
    mode: "full",
    testFiles: Array.from({ length: 151 }, (_, index) => `lib/test-${index}.test.ts`),
    maxShards: 1,
  })
  const calls = []
  const env = {
    JEST_TIMING_OUTPUT: "coverage/jest-timings.json",
    JEST_JUNIT_OUTPUT_NAME: "junit-shard-1.xml",
  }
  assert.equal(
    runPlannedShard(plan, 1, {
      coverage: true,
      env,
      run: (args, childEnv) => {
        calls.push(args)
        assert.deepEqual(childEnv, { ...env, JEST_COVERAGE: "1" })
        return { exitCode: 0 }
      },
    }),
    0
  )
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes("--coverage"))
})

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

test("CI changed coverage is full-mode opt-in and consumes only a successful complete merge", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8")
  )
  const changed = workflow.jobs["coverage-changed"]
  assert.ok(changed.needs.includes("jest-plan"))
  assert.match(changed.if, /needs\.jest-plan\.outputs\.mode == 'full'/)
  assert.match(workflow.jobs["coverage-merge"].if, /needs\.jest-plan\.outputs\.mode == 'full'/)
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
