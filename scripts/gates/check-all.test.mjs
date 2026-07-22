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
  gatesInGroup,
  groupManifest,
  hasGate,
  listGroups,
  parseArgs,
  renderSummaryMarkdown,
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
  ]) {
    assert.ok(hasGate(script), `${script} should be registered`)
  }
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
  assert.deepEqual(parseArgs([]), { listGroups: false, json: false, bail: false })
  assert.equal(parseArgs(["--group", "audit"]).group, "audit")
  assert.equal(parseArgs(["--runtime", "rust"]).runtime, "rust")
  assert.equal(parseArgs(["--bail"]).bail, true)

  const listing = parseArgs(["--list-groups", "--json"])
  assert.equal(listing.listGroups, true)
  assert.equal(listing.json, true)

  assert.throws(() => parseArgs(["--group"]), /--group requires/)
  assert.throws(() => parseArgs(["--runtime"]), /--runtime requires/)
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/)
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
