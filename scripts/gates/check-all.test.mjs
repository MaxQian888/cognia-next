/**
 * Coverage for scripts/check-all.mjs — the pure summary/exit-code reducer.
 *
 * We don't spawn the real gates (that would take minutes and depend on the
 * whole repo state). Instead we exercise `summarize` directly, which is the
 * only logic with branches worth pinning.
 *
 * Run with: node --test scripts/check-all.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { GATES, summarize } from "./check-all.mjs"

test("GATES lists the read-only gates and excludes the unsorted i18n:sort:check", () => {
  assert.ok(GATES.includes("typecheck"))
  assert.ok(GATES.includes("lint:i18n"))
  assert.ok(GATES.includes("release:sync-keys:check"))
  assert.ok(GATES.includes("i18n:build:check"))
  assert.ok(GATES.includes("audit:command-parity"))
  assert.ok(GATES.includes("audit:pii-boundaries"))
  assert.ok(GATES.includes("lint:static-export"))
  assert.ok(GATES.includes("config:sync:check"))
  assert.ok(!GATES.includes("i18n:sort:check"))
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

test("summarize → empty input passes vacuously with exit 0", () => {
  const { exitCode } = summarize([])
  assert.equal(exitCode, 0)
})
