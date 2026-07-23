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

import {
  GATES,
  RUNTIMES,
  defaultJobCount,
  effectiveJobCount,
  gatesInGroup,
  groupManifest,
  hasGate,
  listGroups,
  parseArgs,
  renderSummaryMarkdown,
  runGatePlan,
  selectGates,
  summarize,
} from "./check-all.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

test("registry covers the read-only gates and excludes the unsorted i18n:sort:check", () => {
  for (const script of [
    "typecheck",
    "knip",
    "lint",
    "lint:i18n",
    "release:sync-keys:check",
    "i18n:build:check",
    "audit:command-parity",
    "audit:e2e-governance",
    "audit:pii-boundaries",
    "lint:static-export",
    "config:sync:check",
  ]) {
    assert.ok(hasGate(script), `${script} should be registered`)
  }
  assert.ok(!hasGate("i18n:sort:check"))
})

test("registry picks up the gates that were previously wired to nothing", () => {
  // Each of these existed as a script but ran in neither CI nor check:all.
  // Regression pins: losing them again is the exact failure this file guards.
  for (const script of [
    "build:packages",
    "version:sync:check",
    "audit:trusted-publishers",
    "skills:check",
    "plugin-node:check",
    "plugin-convert:check",
    "lint:claude-md",
    "test:coverage:runner:test",
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
