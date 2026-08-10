import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { mergeTimingFiles } from "./merge-jest-timings.mjs"

const require = createRequire(import.meta.url)
const {
  balanceWeightedTests,
  estimateTestWeights,
  mergeTimingManifests,
  normalizeTimingManifest,
} = require("./jest-timing-sequencer.cjs")

test("balanceWeightedTests distributes long suites across shards without gaps or duplicates", () => {
  const weighted = [
    ["a.test.ts", 100],
    ["b.test.ts", 90],
    ["c.test.ts", 80],
    ["d.test.ts", 70],
    ["e.test.ts", 60],
    ["f.test.ts", 50],
    ["g.test.ts", 40],
    ["h.test.ts", 30],
  ].map(([id, weight]) => ({ id, weight }))

  const shards = balanceWeightedTests(weighted, 4)

  assert.deepEqual(
    shards.map((shard) => shard.weight),
    [130, 130, 130, 130]
  )
  assert.deepEqual(
    shards.flatMap((shard) => shard.tests.map((item) => item.id)).sort(),
    weighted.map((item) => item.id).sort()
  )
})

test("estimateTestWeights uses history and a bounded file-size fallback for new suites", () => {
  const tests = [
    { id: "known.test.ts", size: 100 },
    { id: "small-new.test.ts", size: 50 },
    { id: "large-new.test.ts", size: 1_000 },
  ]
  const manifest = {
    version: 1,
    tests: {
      "known.test.ts": { durationMs: 2_000, updatedAt: "2026-08-10T00:00:00.000Z" },
    },
  }

  const weighted = estimateTestWeights(tests, manifest)

  assert.deepEqual(weighted, [
    { id: "known.test.ts", size: 100, weight: 2_000 },
    { id: "small-new.test.ts", size: 50, weight: 1_000 },
    { id: "large-new.test.ts", size: 1_000, weight: 4_000 },
  ])
})

test("mergeTimingManifests keeps the newest observation from every shard", () => {
  const merged = mergeTimingManifests([
    {
      version: 1,
      tests: {
        "a.test.ts": { durationMs: 100, updatedAt: "2026-08-09T00:00:00.000Z" },
        "shared.test.ts": { durationMs: 200, updatedAt: "2026-08-09T00:00:00.000Z" },
      },
    },
    {
      version: 1,
      tests: {
        "b.test.ts": { durationMs: 300, updatedAt: "2026-08-10T00:00:00.000Z" },
        "shared.test.ts": { durationMs: 250, updatedAt: "2026-08-10T00:00:00.000Z" },
      },
    },
  ])

  assert.deepEqual(merged, {
    version: 1,
    tests: {
      "a.test.ts": { durationMs: 100, updatedAt: "2026-08-09T00:00:00.000Z" },
      "b.test.ts": { durationMs: 300, updatedAt: "2026-08-10T00:00:00.000Z" },
      "shared.test.ts": { durationMs: 250, updatedAt: "2026-08-10T00:00:00.000Z" },
    },
  })
})

test("normalizeTimingManifest rejects malformed timing maps without throwing", () => {
  assert.deepEqual(normalizeTimingManifest({ version: 1, tests: null }), {
    version: 1,
    tests: {},
  })
})

test("mergeTimingFiles writes one reusable manifest for the next CI run", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cognia-jest-timings-"))
  const first = path.join(directory, "first.json")
  const second = path.join(directory, "second.json")
  const output = path.join(directory, "merged", "timings.json")
  writeFileSync(
    first,
    JSON.stringify({
      version: 1,
      tests: { "a.test.ts": { durationMs: 100, updatedAt: "2026-08-09T00:00:00.000Z" } },
    })
  )
  writeFileSync(
    second,
    JSON.stringify({
      version: 1,
      tests: { "b.test.ts": { durationMs: 200, updatedAt: "2026-08-10T00:00:00.000Z" } },
    })
  )

  const count = mergeTimingFiles([first, second], output)

  assert.equal(count, 2)
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
    version: 1,
    tests: {
      "a.test.ts": { durationMs: 100, updatedAt: "2026-08-09T00:00:00.000Z" },
      "b.test.ts": { durationMs: 200, updatedAt: "2026-08-10T00:00:00.000Z" },
    },
  })
})
