/**
 * Coverage for scripts/gates/check-all.mjs — the gate registry and its pure
 * reducers.
 *
 * We don't spawn the real gates (that would take minutes and depend on the
 * whole repo state). Instead we exercise the pure functions directly, plus
 * one structural check that every registry entry names a script that really
 * exists in package.json — the registry is only a source of truth if it
 * cannot silently point at nothing.
 *
 * Run with: node --test scripts/gates/check-all.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { execFileSync, spawnSync } from "node:child_process"

import {
  GATES,
  buildQualityPlan,
  RUNTIMES,
  defaultJobCount,
  effectiveJobCount,
  gatesInGroup,
  groupManifest,
  hasGate,
  isReusableLintCacheResult,
  listGroups,
  parseArgs,
  renderSummaryMarkdown,
  runGatePlan,
  selectGates,
  summarize,
} from "./check-all.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

test("lint cache completion accepts validation failures but rejects incomplete or fatal runs", () => {
  const completed = { exitCode: 1, signal: null, output: "✖ 2 problems (1 error, 1 warning)\n" }
  assert.equal(isReusableLintCacheResult("lint", completed), true)
  assert.equal(isReusableLintCacheResult("lint", { ...completed, exitCode: 2 }), false)
  assert.equal(isReusableLintCacheResult("lint", { ...completed, signal: "SIGTERM" }), false)
  assert.equal(isReusableLintCacheResult("lint", { ...completed, exitCode: null }), false)
  assert.equal(
    isReusableLintCacheResult("lint", { ...completed, output: "could not load config" }),
    false
  )
  assert.equal(isReusableLintCacheResult("lint", { ...completed, exitCode: 0, output: "" }), true)
  assert.equal(
    isReusableLintCacheResult("format:check", {
      ...completed,
      output:
        "[warn] Code style issues found in the above file. Run Prettier with --write to fix.\n",
    }),
    true
  )
  assert.equal(
    isReusableLintCacheResult("format:check", {
      ...completed,
      output: "[error] Invalid printWidth value. Expected an integer, but received false.\n",
    }),
    false
  )
  assert.equal(
    isReusableLintCacheResult("format:check", {
      ...completed,
      exitCode: 2,
      output: "[warn] Code style issues found in 1 file. Run Prettier with --write to fix.\n",
    }),
    false
  )
  assert.equal(isReusableLintCacheResult("typecheck", { ...completed, exitCode: 0 }), false)
})

test("CLI publishes cache readiness only after completed lint validation without changing its failure", () => {
  const cwd = mkdtempSync(join(tmpdir(), "quality-cache-completion-"))
  try {
    const command = join(REPO_ROOT, "scripts/gates/check-all.mjs")
    const outputFile = join(cwd, "github-output")
    for (const scenario of [
      { status: 1, output: "✖ 1 problem (1 error, 0 warnings)", cache: true, ready: true },
      { status: 1, output: "✖ 1 problem (1 error, 0 warnings)", cache: false, ready: false },
      { status: 2, output: "Oops! Something went wrong!", cache: true, ready: false },
      { status: 1, output: "could not load config", cache: true, ready: false },
      {
        status: 1,
        signal: "SIGTERM",
        output: "✖ 1 problem (1 error, 0 warnings)",
        cache: true,
        ready: false,
      },
      { status: 0, output: "", cache: true, ready: true },
    ]) {
      rmSync(join(cwd, ".cache"), { recursive: true, force: true })
      writeFileSync(outputFile, "")
      writeFileSync(
        join(cwd, "pnpm"),
        `#!${process.execPath}\nconst fs=require('node:fs');\n${scenario.cache ? "fs.mkdirSync('.cache',{recursive:true});fs.writeFileSync('.cache/eslint','fixture');" : ""}\nconsole.log(${JSON.stringify(scenario.output)});${scenario.signal ? `process.kill(process.pid, ${JSON.stringify(scenario.signal)})` : `process.exitCode=${scenario.status}`};\n`,
        { mode: 0o755 }
      )
      const run = spawnSync(process.execPath, [command, "--group", "lint"], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: "",
          PATH: `${cwd}:${process.env.PATH}`,
        },
      })
      assert.equal(run.status, scenario.status === 0 ? 0 : 1, run.stderr)
      assert.match(
        readFileSync(outputFile, "utf8"),
        new RegExp(`lint-cache-ready=${scenario.ready}\\n`)
      )
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("the real plugin scaffold build requires Rust and the shared Cargo resource", () => {
  const scaffold = GATES.find((gate) => gate.script === "sdk:scaffold:test")
  assert.equal(scaffold.runtime, "rust")
  assert.equal(scaffold.resource, "cargo")
  assert.equal(groupManifest([scaffold])[0].rust, true)
})

function changes(changedFiles, overrides = {}) {
  return {
    version: 1,
    mode: "incremental",
    head: "a".repeat(40),
    base: "b".repeat(40),
    diffBase: "b".repeat(40),
    mergeBase: null,
    comparison: "endpoints",
    changedFiles,
    deletedFiles: [],
    reason: "test change range",
    ...overrides,
  }
}

test("documentation changes keep global invariants without builds or native toolchains", () => {
  const plan = buildQualityPlan(changes(["docs/content/docs/en/guides/chat.mdx"]))
  const scripts = plan.selected.map((gate) => gate.script)
  assert.ok(scripts.includes("gates:registry"))
  assert.ok(scripts.includes("audit:docs-links"))
  assert.ok(scripts.includes("audit:adr-catalog"))
  for (const script of ["typecheck", "knip", "build:packages", "sdk:ts:build", "rust:clippy"]) {
    assert.ok(!scripts.includes(script), `${script} should not run for documentation`)
  }
  assert.ok(plan.include.every((group) => !group.python && !group.rust))
  assert.equal(plan.mode, "incremental")
  assert.equal(plan.head, "a".repeat(40))
  assert.equal(plan.selected.length + plan.skipped.length, GATES.length)
  assert.ok([...plan.selected, ...plan.skipped].every((gate) => gate.reason))
})

test("frontend leaf changes retain frontend checks without unrelated native SDK suites", () => {
  const plan = buildQualityPlan(changes(["components/chat/message.tsx"]))
  const scripts = plan.selected.map((gate) => gate.script)
  for (const script of [
    "lint",
    "typecheck",
    "lint:i18n",
    "audit:colocated-tests",
    "gates:registry",
  ]) {
    assert.ok(scripts.includes(script), `${script} must run for frontend changes`)
  }
  for (const script of ["sdk:python:test", "sdk:rust:test", "rust:clippy", "scripts:test:ci"]) {
    assert.ok(!scripts.includes(script), `${script} should not run for a frontend leaf`)
  }
  const tests = plan.include.find((group) => group.group === "gate-tests")
  assert.equal(tests.rust, false, "runtime requirements must reflect selected gates only")
  for (const group of plan.include) {
    assert.deepEqual(
      group.scripts,
      plan.selected.filter((gate) => gate.group === group.group).map((gate) => gate.script)
    )
  }
})

test("native and shared contract inputs retain the native checks", () => {
  for (const path of [
    "src-tauri/src/lib.rs",
    "crates/example/src/lib.rs",
    "protocol/commands.json",
    "docs/api/mobile-companion-api.openapi.yaml",
    "metadata/contracts.json",
  ]) {
    const scripts = buildQualityPlan(changes([path])).selected.map((gate) => gate.script)
    assert.ok(scripts.includes("rust:clippy"), path)
    assert.ok(scripts.includes("sdk:rust:test"), path)
    assert.ok(scripts.includes("sdk:ts:build"), path)
  }
})

test("ordinary block component filenames do not trigger the dependency-lock fallback", () => {
  const plan = buildQualityPlan(changes(["components/chat/lifecycle-status-block.tsx"]))
  assert.equal(plan.mode, "incremental")
  assert.ok(plan.include.every((group) => !group.rust && !group.python))
})

test("author declaration checks keep their package build prerequisite in the same lane", () => {
  for (const path of [
    "packages/agent/src/index.ts",
    "docs/api/mobile-companion-api.openapi.yaml",
  ]) {
    const artifacts = buildQualityPlan(changes([path])).include.find(
      (group) => group.group === "artifacts"
    )
    assert.ok(artifacts.scripts.includes("author-types:check"))
    assert.ok(
      artifacts.scripts.indexOf("build:packages") < artifacts.scripts.indexOf("author-types:check")
    )
  }
})

test("uncertain inputs, deletions, shared configuration and explicit full mode select every gate", () => {
  for (const manifest of [
    changes(["new-area/module.ts"]),
    changes(["pnpm-lock.yaml"]),
    changes(["plugins/repowiki/uv.lock"]),
    changes(["packages/agent/package.json"]),
    changes(["tsconfig.json"]),
    changes([".github/workflows/quality.yml"]),
    changes(["scripts/gates/check-all.mjs"]),
    changes(["components/deleted.tsx"], { deletedFiles: ["components/deleted.tsx"] }),
    changes([], { mode: "full", reason: "nightly full validation" }),
  ]) {
    const plan = buildQualityPlan(manifest)
    assert.equal(plan.mode, "full")
    assert.equal(plan.selected.length, GATES.length, JSON.stringify(manifest))
    assert.deepEqual(plan.skipped, [])
  }
})

test("unscoped new gates default to always selected", () => {
  const gate = { script: "new:gate", group: "gate-tests", runtime: "node", blocking: true }
  GATES.push(gate)
  try {
    assert.ok(buildQualityPlan(changes([])).selected.some((entry) => entry.script === gate.script))
  } finally {
    GATES.pop()
  }
})

test("invalid change manifests are rejected instead of silently skipping gates", () => {
  for (const manifest of [
    null,
    {},
    changes([], { version: 2 }),
    changes([], { changedFiles: "file" }),
    changes(["../escape"]),
    changes([], { head: "main" }),
  ]) {
    assert.throws(() => buildQualityPlan(manifest))
  }
  assert.equal(parseArgs(["--change-plan", "plan.json"]).changePlan, "plan.json")
  assert.throws(() => parseArgs(["--change-plan"]), /--change-plan requires/)
})

test("CLI rejects stale manifests and executes exactly the planned group scripts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "quality-plan-"))
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  try {
    git("init", "--quiet")
    git(
      "-c",
      "user.name=CI Test",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture"
    )
    const head = git("rev-parse", "HEAD")
    const file = join(cwd, "change-plan.json")
    const manifest = changes(["components/chat/message.tsx"], { head, base: head, diffBase: head })
    writeFileSync(file, JSON.stringify(manifest))
    const command = join(REPO_ROOT, "scripts/gates/check-all.mjs")
    const listing = spawnSync(
      process.execPath,
      [command, "--change-plan", file, "--list-groups", "--json"],
      { cwd, encoding: "utf8" }
    )
    assert.equal(listing.status, 0, listing.stderr)
    const groups = JSON.parse(listing.stdout)
    assert.deepEqual(groups, buildQualityPlan(manifest).include)
    const log = join(cwd, "invocations.jsonl")
    writeFileSync(
      join(cwd, "pnpm"),
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+"\\n")\n`,
      { mode: 0o755 }
    )
    const run = spawnSync(process.execPath, [command, "--change-plan", file, "--group", "types"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${cwd}:${process.env.PATH}` },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)[1]),
      groups.find((group) => group.group === "types").scripts
    )
    writeFileSync(file, JSON.stringify({ ...manifest, head: "a".repeat(40) }))
    const stale = spawnSync(
      process.execPath,
      [command, "--change-plan", file, "--group", "types"],
      { cwd, encoding: "utf8" }
    )
    assert.notEqual(stale.status, 0)
    assert.match(stale.stderr, /HEAD|head/)
    writeFileSync(file, "{invalid json")
    const malformed = spawnSync(
      process.execPath,
      [command, "--change-plan", file, "--list-groups", "--json"],
      { cwd, encoding: "utf8" }
    )
    assert.notEqual(malformed.status, 0)
    assert.equal(malformed.stdout, "")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("registry covers the read-only gates", () => {
  for (const script of [
    "typecheck",
    "knip",
    "lint",
    "lint:i18n",
    "release:sync-keys:check",
    "i18n:build:check",
    "i18n:sort:check",
    "audit:command-parity",
    "audit:companion-command-manifest",
    "audit:e2e-governance",
    "audit:pii-boundaries",
    "audit:package-boundaries",
    "lint:static-export",
    "config:sync:check",
    "test:db-fixture:audit",
  ]) {
    assert.ok(hasGate(script), `${script} should be registered`)
  }
})

test("registry picks up the gates that were previously wired to nothing", () => {
  // Each of these existed as a script but ran in neither CI nor check:all.
  // Regression pins: losing them again is the exact failure this file guards.
  for (const script of [
    "build:packages",
    "version:sync:check",
    "audit:trusted-publishers",
    "audit:docs-links",
    "skills:check",
    "plugin-node:check",
    "plugin-convert:check",
    "ide:check",
    "lint:claude-md",
    "test:coverage:runner:test",
    "sidecar:codeserver-agent:test",
  ]) {
    assert.ok(hasGate(script), `${script} should be registered`)
  }
})

test("TypeScript graph analysis never competes with declaration builds", () => {
  for (const script of ["typecheck", "knip", "build:packages", "sdk:ts:build"]) {
    assert.equal(
      GATES.find((gate) => gate.script === script)?.resource,
      "package-build",
      `${script} must share the package-build resource lock`
    )
  }
})

test("lint and formatting occupy independent lanes", () => {
  assert.equal(GATES.find((gate) => gate.script === "lint")?.group, "lint")
  assert.equal(GATES.find((gate) => gate.script === "format:check")?.group, "format")
})

test("every registry entry names a real package.json script", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))
  const missing = GATES.filter((g) => !(g.script in pkg.scripts)).map((g) => g.script)
  assert.deepEqual(missing, [], `registry references non-existent scripts: ${missing.join(", ")}`)
})

test("entries are normalized with runtime/blocking defaults", () => {
  for (const gate of GATES) {
    assert.ok(RUNTIMES.includes(gate.runtime), `${gate.script} has runtime ${gate.runtime}`)
    assert.equal(typeof gate.blocking, "boolean")
    assert.equal(typeof gate.group, "string")
    assert.ok(gate.group.length > 0)
  }
})

test("every registered quality gate is blocking", () => {
  assert.equal(
    GATES.filter((gate) => !gate.blocking).length,
    0,
    "check:all must not silently tolerate failed quality gates"
  )
})

test("listGroups is de-duplicated and preserves first-seen order", () => {
  const groups = listGroups()
  assert.deepEqual(groups, [...new Set(groups)])
  assert.equal(groups[0], GATES[0].group)
  assert.ok(groups.includes("audit"))
  assert.ok(groups.includes("plugin-sdk"))
})

test("groupManifest flags the runtimes each group needs", () => {
  const manifest = groupManifest()
  assert.deepEqual(
    manifest.map((m) => m.group),
    listGroups()
  )

  const lint = manifest.find((m) => m.group === "lint")
  assert.deepEqual(lint, { group: "lint", node: true, python: false, rust: false })

  // plugin-sdk is the multi-runtime group: TS build + pytest + cargo.
  const sdk = manifest.find((m) => m.group === "plugin-sdk")
  assert.equal(sdk.node, true)
  assert.equal(sdk.python, true)
  assert.equal(sdk.rust, true)
})

test("gatesInGroup returns only that group's entries", () => {
  const audit = gatesInGroup("audit")
  assert.ok(audit.length > 1)
  assert.ok(audit.every((g) => g.group === "audit"))
  assert.equal(gatesInGroup("no-such-group").length, 0)
})

test("selectGates filters by group and runtime, and rejects unknown values", () => {
  assert.equal(selectGates().length, GATES.length)
  assert.ok(selectGates({ group: "i18n" }).every((g) => g.group === "i18n"))
  assert.ok(selectGates({ runtime: "rust" }).every((g) => g.runtime === "rust"))

  const nodeOnly = selectGates({ runtime: "node" })
  assert.ok(nodeOnly.length < GATES.length, "python/rust gates should be filtered out")

  assert.throws(() => selectGates({ group: "nope" }), /Unknown gate group/)
  assert.throws(() => selectGates({ runtime: "cobol" }), /Unknown runtime/)
})

test("parseArgs reads the CLI surface and rejects junk", () => {
  assert.deepEqual(parseArgs([]), {
    listGroups: false,
    json: false,
    bail: false,
    jobs: undefined,
  })
  assert.equal(parseArgs(["--group", "audit"]).group, "audit")
  assert.equal(parseArgs(["--runtime", "rust"]).runtime, "rust")
  assert.equal(parseArgs(["--bail"]).bail, true)
  assert.equal(parseArgs(["--jobs", "3"]).jobs, 3)

  const listing = parseArgs(["--list-groups", "--json"])
  assert.equal(listing.listGroups, true)
  assert.equal(listing.json, true)

  assert.throws(() => parseArgs(["--group"]), /--group requires/)
  assert.throws(() => parseArgs(["--runtime"]), /--runtime requires/)
  assert.throws(() => parseArgs(["--jobs", "0"]), /positive integer/)
  assert.throws(() => parseArgs(["--jobs", "1.5"]), /positive integer/)
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/)
})

test("defaultJobCount uses available CPUs without oversubscribing local builds", () => {
  assert.equal(defaultJobCount(1), 1)
  assert.equal(defaultJobCount(2), 2)
  assert.equal(defaultJobCount(8), 4)
  assert.equal(defaultJobCount(64), 4)
})

test("effectiveJobCount never exceeds the selected group count and makes bail sequential", () => {
  const gates = [
    { script: "lint", group: "lint" },
    { script: "format:check", group: "lint" },
    { script: "typecheck", group: "types" },
  ]
  assert.equal(effectiveJobCount(gates, 4, false), 2)
  assert.equal(effectiveJobCount(gates.slice(0, 2), 4, false), 1)
  assert.equal(effectiveJobCount(gates, 4, true), 1)
})

test("summarize → exit 0 and pass header when every gate is green", () => {
  const { exitCode, summary } = summarize([
    { name: "typecheck", ok: true },
    { name: "lint", ok: true },
  ])
  assert.equal(exitCode, 0)
  assert.match(summary, /all 2 gate\(s\) passed/)
  assert.match(summary, /✓ typecheck/)
})

test("summarize → exit 1 and counts only failures, not skips", () => {
  const { exitCode, summary } = summarize([
    { name: "typecheck", ok: true },
    { name: "lint", ok: false },
    { name: "lint:i18n", ok: false, skipped: true },
  ])
  assert.equal(exitCode, 1)
  // 1 real failure out of 2 gates that actually ran (the skipped one is excluded).
  assert.match(summary, /1\/2 gate\(s\) FAILED/)
  assert.match(summary, /✗ lint/)
  assert.match(summary, /∅ lint:i18n \(skipped\)/)
})

test("summarize → a failing advisory gate is reported but never fails the build", () => {
  const { exitCode, summary } = summarize([
    { name: "lint", ok: true, blocking: true },
    { name: "audit:deps", ok: false, blocking: false },
  ])
  assert.equal(exitCode, 0)
  assert.match(summary, /all 2 gate\(s\) passed/)
  assert.match(summary, /! audit:deps \(advisory\)/)
})

test("summarize → empty input passes vacuously with exit 0", () => {
  const { exitCode } = summarize([])
  assert.equal(exitCode, 0)
})

test("renderSummaryMarkdown emits a titled table with one row per gate", () => {
  const md = renderSummaryMarkdown(
    [
      { name: "lint", ok: true, blocking: true },
      { name: "format:check", ok: false, blocking: true },
      { name: "audit:deps", ok: false, blocking: false },
      { name: "typecheck", ok: false, skipped: true, blocking: true },
    ],
    "lint"
  )
  assert.match(md, /^### Gates — `lint`/)
  assert.match(md, /1\/3 gate\(s\) FAILED/)
  assert.match(md, /\| `lint` \| ✅ pass \|/)
  assert.match(md, /\| `format:check` \| ❌ FAIL \|/)
  assert.match(md, /\| `audit:deps` \| ⚠️ advisory \|/)
  assert.match(md, /\| `typecheck` \| ⏭️ skipped \|/)
})

test("renderSummaryMarkdown falls back to a generic title without a group", () => {
  const md = renderSummaryMarkdown([{ name: "lint", ok: true, blocking: true }])
  assert.match(md, /^### Gates\n/)
})

test("runGatePlan runs groups concurrently while preserving order within each group", async () => {
  const gates = [
    { script: "lint", group: "lint", blocking: true },
    { script: "format:check", group: "lint", blocking: true },
    { script: "typecheck", group: "types", blocking: true },
  ]
  const started = []
  const finish = new Map()
  const executeGate = (gate) => {
    started.push(gate.script)
    return new Promise((resolve) => finish.set(gate.script, resolve))
  }

  const run = runGatePlan(gates, { jobs: 2, executeGate })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(started, ["lint", "typecheck"])
  assert.ok(!started.includes("format:check"), "a group must never overlap its own gates")

  finish.get("typecheck")(true)
  finish.get("lint")(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ["lint", "typecheck", "format:check"])

  finish.get("format:check")(true)
  assert.deepEqual(await run, [
    { name: "lint", ok: true, blocking: true },
    { name: "format:check", ok: true, blocking: true },
    { name: "typecheck", ok: true, blocking: true },
  ])
})

test("runGatePlan keeps --bail sequential and marks every remaining gate skipped", async () => {
  const gates = [
    { script: "lint", group: "lint", blocking: true },
    { script: "format:check", group: "lint", blocking: true },
    { script: "typecheck", group: "types", blocking: true },
  ]
  const started = []
  const results = await runGatePlan(gates, {
    jobs: 4,
    bail: true,
    executeGate: async (gate) => {
      started.push(gate.script)
      return gate.script !== "lint"
    },
  })

  assert.deepEqual(started, ["lint"])
  assert.deepEqual(results, [
    { name: "lint", ok: false, blocking: true },
    { name: "format:check", ok: false, skipped: true, blocking: true },
    { name: "typecheck", ok: false, skipped: true, blocking: true },
  ])
})

test("runGatePlan never overlaps gates that claim the same local resource", async () => {
  const gates = [
    { script: "build:packages", group: "artifacts", blocking: true, resource: "packages" },
    { script: "sdk:ts:build", group: "plugin-sdk", blocking: true, resource: "packages" },
    { script: "typecheck", group: "types", blocking: true },
  ]
  const started = []
  const finish = new Map()
  const run = runGatePlan(gates, {
    jobs: 3,
    executeGate: (gate) => {
      started.push(gate.script)
      return new Promise((resolve) => finish.set(gate.script, resolve))
    },
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(started, ["build:packages", "typecheck"])
  finish.get("build:packages")(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ["build:packages", "typecheck", "sdk:ts:build"])

  finish.get("typecheck")(true)
  finish.get("sdk:ts:build")(true)
  await run
})
