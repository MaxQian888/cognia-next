/* eslint-disable @typescript-eslint/no-require-imports -- Jest loads custom sequencers as CommonJS. */
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs")
const path = require("node:path")

const DefaultSequencer = require("@jest/test-sequencer").default

const MANIFEST_VERSION = 1
const DEFAULT_TIMING_PATH = path.join(process.cwd(), ".cache/jest/timings.json")

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function normalizeTimingManifest(value) {
  const tests = {}
  if (
    value?.version !== MANIFEST_VERSION ||
    value.tests === null ||
    typeof value.tests !== "object"
  ) {
    return { version: MANIFEST_VERSION, tests }
  }
  for (const [testPath, entry] of Object.entries(value.tests)) {
    if (
      typeof entry?.durationMs === "number" &&
      Number.isFinite(entry.durationMs) &&
      entry.durationMs > 0 &&
      typeof entry.updatedAt === "string"
    ) {
      tests[testPath] = { durationMs: entry.durationMs, updatedAt: entry.updatedAt }
    }
  }
  return { version: MANIFEST_VERSION, tests }
}

function readTimingManifest(filePath) {
  try {
    return normalizeTimingManifest(JSON.parse(readFileSync(filePath, "utf8")))
  } catch {
    return { version: MANIFEST_VERSION, tests: {} }
  }
}

function writeTimingManifest(filePath, manifest) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(normalizeTimingManifest(manifest), null, 2)}\n`)
}

function estimateTestWeights(tests, manifest) {
  const known = tests
    .map((test) => manifest.tests[test.id]?.durationMs)
    .filter((duration) => typeof duration === "number" && duration > 0)
  const fallbackDuration = median(known)
  const fallbackSize = median(tests.map((test) => Math.max(1, test.size)))

  return tests.map((test) => {
    const observed = manifest.tests[test.id]?.durationMs
    if (typeof observed === "number" && observed > 0) return { ...test, weight: observed }
    if (fallbackDuration === 0) return { ...test, weight: Math.max(1, test.size) }

    const sizeRatio = Math.max(0.5, Math.min(2, Math.max(1, test.size) / fallbackSize))
    return { ...test, weight: fallbackDuration * sizeRatio }
  })
}

function balanceWeightedTests(tests, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("shardCount must be a positive integer")
  }
  const shards = Array.from({ length: shardCount }, () => ({ tests: [], weight: 0 }))
  const longestFirst = [...tests].sort(
    (left, right) => right.weight - left.weight || left.id.localeCompare(right.id)
  )

  for (const test of longestFirst) {
    const target = shards.reduce((best, shard) => {
      if (shard.weight !== best.weight) return shard.weight < best.weight ? shard : best
      if (shard.tests.length !== best.tests.length) {
        return shard.tests.length < best.tests.length ? shard : best
      }
      return best
    })
    target.tests.push(test)
    target.weight += test.weight
  }
  return shards
}

function mergeTimingManifests(manifests) {
  const merged = { version: MANIFEST_VERSION, tests: {} }
  for (const value of manifests) {
    const manifest = normalizeTimingManifest(value)
    for (const [testPath, entry] of Object.entries(manifest.tests)) {
      const current = merged.tests[testPath]
      if (!current || entry.updatedAt > current.updatedAt) merged.tests[testPath] = entry
    }
  }
  return merged
}

function relativeTestPath(test) {
  return path.relative(test.context.config.rootDir, test.path).split(path.sep).join("/")
}

class TimingShardSequencer extends DefaultSequencer {
  constructor(options) {
    super(options)
    this.timingInput = process.env.JEST_TIMING_INPUT || DEFAULT_TIMING_PATH
    this.timingOutput = process.env.JEST_TIMING_OUTPUT || this.timingInput
    this.timingManifest = readTimingManifest(this.timingInput)
  }

  shard(tests, { shardIndex, shardCount }) {
    const descriptors = tests.map((test) => {
      const id = relativeTestPath(test)
      return {
        id,
        size: test.context.hasteFS.getSize(test.path) ?? 0,
        test,
      }
    })
    const weighted = estimateTestWeights(descriptors, this.timingManifest)
    const shards = balanceWeightedTests(weighted, shardCount)
    return shards[shardIndex - 1].tests.map((item) => item.test)
  }

  cacheResults(tests, results) {
    super.cacheResults(tests, results)
    const testIds = new Map(tests.map((test) => [test.path, relativeTestPath(test)]))
    const updatedAt = new Date().toISOString()
    for (const result of results.testResults) {
      const id = testIds.get(result.testFilePath)
      const runtime = result.perfStats.runtime ?? result.perfStats.end - result.perfStats.start
      if (id && Number.isFinite(runtime) && runtime > 0) {
        this.timingManifest.tests[id] = { durationMs: runtime, updatedAt }
      }
    }
    writeTimingManifest(this.timingOutput, this.timingManifest)
  }
}

module.exports = TimingShardSequencer
module.exports.balanceWeightedTests = balanceWeightedTests
module.exports.estimateTestWeights = estimateTestWeights
module.exports.mergeTimingManifests = mergeTimingManifests
module.exports.normalizeTimingManifest = normalizeTimingManifest
module.exports.readTimingManifest = readTimingManifest
module.exports.writeTimingManifest = writeTimingManifest
