import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import { evaluate, main, validateResult, withBaseline } from "./check-pro-ide-perf.mjs"

const run = (overrides = {}) => ({
  platform: "linux-x64",
  codeServer: "4.128.0",
  coldReadinessMs: 3000,
  idleRssMb: 600,
  emptyRpcP95Ms: 2,
  relayOverheadP95Ms: 5,
  eventLoss: 0,
  ...overrides,
})
const baselines = { "linux-x64": withBaseline({}, run())["linux-x64"] }

describe("regression gates: at most 20% and at most the absolute cap", () => {
  test("a run at its baseline passes every gate", () => {
    assert.deepEqual(evaluate(run(), baselines).failures, [])
  })

  test("20% of a 3 s readiness is 600 ms: 3.6 s passes, 3.7 s fails", () => {
    assert.deepEqual(evaluate(run({ coldReadinessMs: 3600 }), baselines).failures, [])
    assert.match(
      evaluate(run({ coldReadinessMs: 3700 }), baselines).failures[0],
      /cold readiness regressed by 700/
    )
  })

  test("a slow baseline does not buy more than 2 s", () => {
    const slow = { "linux-x64": { ...baselines["linux-x64"], coldReadinessMs: 20_000 } }
    // 20% would be 4 s; the cap is 2 s.
    assert.equal(evaluate(run({ coldReadinessMs: 22_500 }), slow).failures.length, 1)
    assert.deepEqual(evaluate(run({ coldReadinessMs: 21_900 }), slow).failures, [])
  })

  test("idle RSS is capped at 150 MiB of growth", () => {
    const big = { "linux-x64": { ...baselines["linux-x64"], idleRssMb: 1400 } }
    assert.match(evaluate(run({ idleRssMb: 1600 }), big).failures[0], /idle RSS regressed by 200/)
    assert.deepEqual(evaluate(run({ idleRssMb: 1500 }), big).failures, [])
  })

  test("getting faster is never a failure", () => {
    assert.deepEqual(evaluate(run({ coldReadinessMs: 100, idleRssMb: 10 }), baselines).failures, [])
  })
})

describe("absolute gates", () => {
  test("RPC p95 above 30 ms and relay p95 above 75 ms fail with or without a baseline", () => {
    const { failures } = evaluate(
      run({ emptyRpcP95Ms: 31, relayOverheadP95Ms: 76 }),
      {},
      {
        allowMissingBaseline: true,
      }
    )
    assert.equal(failures.length, 2)
    assert.match(failures[0], /empty broker RPC p95 31 ms exceeds 30/)
    assert.match(failures[1], /relay overhead p95 76 ms exceeds 75/)
  })
})

describe("event loss", () => {
  test("a single lost lifecycle event fails, and an old result without the count is rejected", () => {
    assert.match(
      evaluate(run({ eventLoss: 1 }), baselines).failures[0],
      /lifecycle events lost 1 events exceeds 0/
    )
    const { eventLoss: _dropped, ...old } = run()
    assert.deepEqual(validateResult(old), ["eventLoss is missing or not a non-negative number"])
  })
})

describe("a platform without a baseline", () => {
  test("fails its regression gates unless explicitly allowed, and says which", () => {
    const strict = evaluate(run({ platform: "darwin-arm64" }), baselines)
    assert.equal(strict.failures.length, 2)
    assert.match(strict.failures[0], /no darwin-arm64 baseline for cold readiness/)
    const allowed = evaluate(run({ platform: "darwin-arm64" }), baselines, {
      allowMissingBaseline: true,
    })
    assert.deepEqual(allowed.failures, [])
    assert.ok(allowed.lines.some((line) => line.startsWith("skip cold readiness")))
  })
})

describe("the result file", () => {
  test("every metric must be a non-negative number", () => {
    assert.deepEqual(validateResult(run()), [])
    assert.deepEqual(validateResult(run({ idleRssMb: -1, platform: "" })), [
      "result has no platform",
      "idleRssMb is missing or not a non-negative number",
    ])
    assert.deepEqual(validateResult(null), ["result is not an object"])
  })

  test("main reports a missing or malformed result as a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "pro-ide-perf-"))
    const log = []
    assert.equal(
      main(["--result", join(dir, "absent.json")], (line) => log.push(line)),
      1
    )
    assert.match(log[0], /not found/)
    const bad = join(dir, "bad.json")
    writeFileSync(bad, JSON.stringify({ platform: "x" }))
    assert.equal(
      main(["--result", bad], (line) => log.push(line)),
      1
    )
    const good = join(dir, "good.json")
    writeFileSync(good, JSON.stringify(run({ platform: "test-only" })))
    assert.equal(
      main(["--result", good, "--allow-missing-baseline"], () => {}),
      0
    )
  })

  test("a recorded baseline keeps the other platforms", () => {
    const recorded = withBaseline({ "darwin-arm64": { coldReadinessMs: 1 } }, run())
    assert.deepEqual(Object.keys(recorded).sort(), ["darwin-arm64", "linux-x64"])
    assert.equal(recorded["linux-x64"].coldReadinessMs, 3000)
    assert.equal(recorded["linux-x64"].platform, undefined)
  })
})
