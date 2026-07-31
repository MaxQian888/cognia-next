import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildCoveragePlan,
  effectiveJobCount,
  executeShardPlan,
  parseArgs,
} from "./run-coverage.mjs"

test("parseArgs defaults to memory-safe shards with bounded parallelism", () => {
  assert.deepEqual(parseArgs([]), {
    shards: 8,
    jobs: 2,
    workers: 4,
    maxOldSpaceSize: 8192,
    out: "coverage",
    only: undefined,
  })
  assert.deepEqual(
    parseArgs(["--shards", "3", "--jobs", "1", "--workers", "2", "--max-old-space-size", "4096"]),
    {
      shards: 3,
      jobs: 1,
      workers: 2,
      maxOldSpaceSize: 4096,
      out: "coverage",
      only: undefined,
    }
  )
  assert.deepEqual(parseArgs(["--only", "3,6,3"]).only, [3, 6])
  assert.deepEqual(parseArgs(["--", "--only", "2"]).only, [2])
  assert.throws(() => parseArgs(["--jobs", "0"]), /positive integer/)
  assert.throws(() => parseArgs(["--workers", "0"]), /positive integer/)
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/)
})

test("effectiveJobCount never oversubscribes the shard count", () => {
  assert.equal(effectiveJobCount(4, 2), 2)
  assert.equal(effectiveJobCount(1, 2), 1)
})

test("buildCoveragePlan isolates reports and defers thresholds to the merge", () => {
  const plan = buildCoveragePlan({ shards: 2, workers: 2, out: "coverage" })
  assert.equal(plan.shards.length, 2)
  assert.ok(plan.shards[0].args.includes("--maxWorkers=2"))
  assert.ok(plan.shards[0].args.includes("--testTimeout=120000"))
  assert.deepEqual(plan.shards[0].args.slice(-4), [
    "--shard=1/2",
    "--coverageDirectory=coverage/shards/shard-1",
    "--coverageReporters=json",
    "--coverageThreshold={}",
  ])
  assert.deepEqual(plan.merge.args, [
    "scripts/test/merge-coverage.mjs",
    "--check",
    "--out",
    "coverage",
    "coverage/shards/shard-1",
    "coverage/shards/shard-2",
  ])
})

test("buildCoveragePlan selects reruns without dropping maps from the final merge", () => {
  const plan = buildCoveragePlan({ shards: 4, out: "coverage", only: [2, 4] })
  assert.deepEqual(
    plan.shards.map((shard) => shard.label),
    ["shard 2/4", "shard 4/4"]
  )
  assert.deepEqual(plan.merge.args.slice(-4), [
    "coverage/shards/shard-1",
    "coverage/shards/shard-2",
    "coverage/shards/shard-3",
    "coverage/shards/shard-4",
  ])
  assert.throws(() => buildCoveragePlan({ shards: 4, out: "coverage", only: [5] }), /within 1-4/)
})

test("executeShardPlan bounds concurrency and does not start more work after failure", async () => {
  const plan = buildCoveragePlan({ shards: 4, out: "coverage" })
  let active = 0
  let peak = 0
  const started = []
  const run = async (command) => {
    started.push(command.label)
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, command.label === "shard 1/4" ? 5 : 20))
    active -= 1
    return command.label === "shard 1/4" ? 1 : 0
  }

  await assert.rejects(() => executeShardPlan(plan.shards, { jobs: 2, run }), /shard 1\/4/)
  assert.equal(peak, 2)
  assert.deepEqual(started.sort(), ["shard 1/4", "shard 2/4"])
})
