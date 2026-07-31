/**
 * Coverage for scripts/gates/check-clippy.mjs.
 *
 * Parsing and ratcheting are pure, so they are tested against captured
 * `cargo --message-format=json` lines rather than by shelling out to cargo
 * (which takes minutes and needs a Rust toolchain). One test reads the
 * committed baseline to pin its shape.
 *
 * Run with: node --test scripts/gates/check-clippy.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { CARGO_ARGS, diffTally, parseClippyWarnings, readBaseline, tally } from "./check-clippy.mjs"

/** One real-shaped cargo message per line. */
const warning = (target, lint) =>
  JSON.stringify({
    reason: "compiler-message",
    target: { name: target },
    message: { level: "warning", code: { code: lint }, message: "…" },
  })

const NDJSON = [
  JSON.stringify({ reason: "compiler-artifact", target: { name: "cognia_net" } }),
  warning("cognia_net", "clippy::needless_borrow"),
  warning("cognia_net", "clippy::needless_borrow"),
  warning("cognia_net", "clippy::type_complexity"),
  warning("cognia_vector", "clippy::redundant_closure"),
  // The end-of-run rollup carries no `code`; counting it would double-count.
  JSON.stringify({
    reason: "compiler-message",
    target: { name: "cognia_net" },
    message: { level: "warning", code: null, message: "3 warnings emitted" },
  }),
  // Errors are not warnings and must never enter the tally.
  JSON.stringify({
    reason: "compiler-message",
    target: { name: "cognia_net" },
    message: { level: "error", code: { code: "E0308" }, message: "mismatched types" },
  }),
  "not json at all",
  "",
].join("\n")

test("CARGO_ARGS excludes src-tauri, which cannot be linted without the static export", () => {
  assert.ok(CARGO_ARGS.includes("--workspace"))
  const excludeIndex = CARGO_ARGS.indexOf("--exclude")
  assert.notEqual(excludeIndex, -1)
  assert.equal(CARGO_ARGS[excludeIndex + 1], "cognia-next")
  assert.ok(CARGO_ARGS.includes("--message-format=json"))
})

test("parseClippyWarnings keeps coded warnings and drops everything else", () => {
  const warnings = parseClippyWarnings(NDJSON)
  assert.equal(warnings.length, 4)
  assert.deepEqual(
    warnings.map((w) => w.lint),
    [
      "clippy::needless_borrow",
      "clippy::needless_borrow",
      "clippy::type_complexity",
      "clippy::redundant_closure",
    ]
  )
})

test("parseClippyWarnings survives malformed lines and empty input", () => {
  assert.deepEqual(parseClippyWarnings(""), [])
  assert.deepEqual(parseClippyWarnings("garbage\n{oops\n"), [])
})

test("tally counts per (target, lint) pair and sorts the keys", () => {
  const counts = tally(parseClippyWarnings(NDJSON))
  assert.equal(counts.total, 4)
  assert.deepEqual(counts.pairs, {
    "cognia_net::clippy::needless_borrow": 2,
    "cognia_net::clippy::type_complexity": 1,
    "cognia_vector::clippy::redundant_closure": 1,
  })
  assert.deepEqual(Object.keys(counts.pairs), [...Object.keys(counts.pairs)].sort())
})

test("diffTally reports nothing when the tally is unchanged", () => {
  const counts = tally(parseClippyWarnings(NDJSON))
  const { regressions, improvements } = diffTally(counts, counts)
  assert.deepEqual(regressions, [])
  assert.deepEqual(improvements, [])
})

test("diffTally flags a growing pair as a regression", () => {
  const { regressions } = diffTally(
    { total: 3, pairs: { "a::clippy::x": 3 } },
    { total: 2, pairs: { "a::clippy::x": 2 } }
  )
  assert.deepEqual(regressions, [{ key: "a::clippy::x", from: 2, to: 3 }])
})

test("diffTally flags a brand-new lint as a regression", () => {
  const { regressions } = diffTally(
    { total: 1, pairs: { "a::clippy::new": 1 } },
    { total: 0, pairs: {} }
  )
  assert.deepEqual(regressions, [{ key: "a::clippy::new", from: 0, to: 1 }])
})

test("diffTally does not let a fix pay for a new warning elsewhere", () => {
  // The exact scenario a bare total would wave through: -5 of one lint,
  // +5 of another, total unchanged.
  const { regressions, improvements } = diffTally(
    { total: 5, pairs: { "a::clippy::added": 5 } },
    { total: 5, pairs: { "a::clippy::fixed": 5 } }
  )
  assert.deepEqual(regressions, [{ key: "a::clippy::added", from: 0, to: 5 }])
  assert.deepEqual(improvements, [{ key: "a::clippy::fixed", from: 5, to: 0 }])
})

test("diffTally reports a shrinking pair as an improvement, never a failure", () => {
  const { regressions, improvements } = diffTally(
    { total: 1, pairs: { "a::clippy::x": 1 } },
    { total: 4, pairs: { "a::clippy::x": 4 } }
  )
  assert.deepEqual(regressions, [])
  assert.deepEqual(improvements, [{ key: "a::clippy::x", from: 4, to: 1 }])
})

test("the committed baseline has the expected shape and a non-trivial debt", () => {
  const baseline = readBaseline()
  assert.equal(baseline.version, 1)
  assert.equal(typeof baseline.total, "number")
  assert.ok(baseline.total > 0, "the workspace had never been linted; the debt is real")
  assert.equal(
    baseline.total,
    Object.values(baseline.pairs).reduce((a, b) => a + b, 0),
    "total must equal the sum of its pairs"
  )
})
