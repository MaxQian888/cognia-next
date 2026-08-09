/**
 * Regression coverage for scripts/clean-stale-turbopack-cache.mjs.
 *
 * The threshold/purge logic is exported, so we exercise it directly against
 * temp directories. Threshold is passed in bytes, so an "over threshold" case
 * needs only a tiny file + a tiny threshold — no multi-GB fixtures.
 *
 * Run with: node --test scripts/clean-stale-turbopack-cache.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  cleanAllNextCaches,
  cleanLegacyWebpackDevArtifacts,
  dirSizeBytes,
  cleanStaleTurbopackCache,
  cleanTurbopackCacheForMode,
  parseArgs,
} from "./clean-stale-turbopack-cache.mjs"

test("parseArgs supports full cleanup and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { all: false })
  assert.deepEqual(parseArgs(["--all"]), { all: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "turbo-cache-"))
}

test("dirSizeBytes sums nested files and returns 0 for a missing dir", () => {
  const root = tmpRoot()
  const cacheDir = join(root, "dev")
  mkdirSync(join(cacheDir, "cache", "turbopack"), { recursive: true })
  writeFileSync(join(cacheDir, "a.sst"), Buffer.alloc(100))
  writeFileSync(join(cacheDir, "cache", "turbopack", "b.sst"), Buffer.alloc(250))

  assert.equal(dirSizeBytes(cacheDir), 350)
  assert.equal(dirSizeBytes(join(root, "does-not-exist")), 0)
  rmSync(root, { recursive: true, force: true })
})

test("purges the cache dir when size exceeds the threshold", () => {
  const root = tmpRoot()
  const cacheDir = join(root, "dev")
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, "big.sst"), Buffer.alloc(500))

  const messages = []
  const result = cleanStaleTurbopackCache({
    cacheDir,
    thresholdBytes: 100,
    log: (m) => messages.push(m),
  })

  assert.equal(result.cleaned, true)
  assert.equal(result.sizeBytes, 500)
  assert.equal(existsSync(cacheDir), false)
  assert.match(messages[0], /purged/)
  rmSync(root, { recursive: true, force: true })
})

test("keeps the cache dir when size is under the threshold", () => {
  const root = tmpRoot()
  const cacheDir = join(root, "dev")
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, "small.sst"), Buffer.alloc(50))

  const messages = []
  const result = cleanStaleTurbopackCache({
    cacheDir,
    thresholdBytes: 1000,
    log: (m) => messages.push(m),
  })

  assert.equal(result.cleaned, false)
  assert.equal(result.sizeBytes, 50)
  assert.equal(existsSync(cacheDir), true)
  assert.match(messages[0], /kept/)
  rmSync(root, { recursive: true, force: true })
})

test("no-op and silent when the cache dir does not exist", () => {
  const root = tmpRoot()
  const messages = []
  const result = cleanStaleTurbopackCache({
    cacheDir: join(root, "dev"),
    thresholdBytes: 100,
    log: (m) => messages.push(m),
  })

  assert.equal(result.cleaned, false)
  assert.equal(result.sizeBytes, 0)
  assert.equal(messages.length, 0)
  rmSync(root, { recursive: true, force: true })
})

test("cache-off mode purges only the Turbopack directory regardless of size", () => {
  const root = tmpRoot()
  const turbopackDir = join(root, ".next", "dev", "cache", "turbopack")
  const siblingDir = join(root, ".next", "dev", "cache", "other")
  mkdirSync(turbopackDir, { recursive: true })
  mkdirSync(siblingDir, { recursive: true })
  writeFileSync(join(turbopackDir, "tiny.sst"), Buffer.alloc(1))
  writeFileSync(join(siblingDir, "keep.bin"), Buffer.alloc(1))

  const result = cleanTurbopackCacheForMode({
    cacheDir: turbopackDir,
    persistentCacheEnabled: false,
    thresholdBytes: 10_000,
    log: () => {},
  })

  assert.equal(result.cleaned, true)
  assert.equal(existsSync(turbopackDir), false)
  assert.equal(existsSync(siblingDir), true)
  rmSync(root, { recursive: true, force: true })
})

test("legacy Webpack dev output is rebuilt as one unit before Turbopack starts", () => {
  const root = tmpRoot()
  const devDir = join(root, ".next", "dev")
  mkdirSync(join(devDir, "cache", "webpack"), { recursive: true })
  mkdirSync(join(devDir, "static", "chunks"), { recursive: true })
  writeFileSync(join(devDir, "cache", "webpack", "index.pack"), Buffer.alloc(20))
  writeFileSync(join(devDir, "static", "chunks", "legacy.js"), Buffer.alloc(30))

  const result = cleanLegacyWebpackDevArtifacts({ devDir, log: () => {} })

  assert.deepEqual(result, { cleaned: true, sizeBytes: 50 })
  assert.equal(existsSync(devDir), false)
  rmSync(root, { recursive: true, force: true })
})

test("current Turbopack dev output is preserved when no Webpack marker exists", () => {
  const root = tmpRoot()
  const devDir = join(root, ".next", "dev")
  mkdirSync(join(devDir, "static", "chunks"), { recursive: true })
  writeFileSync(join(devDir, "static", "chunks", "current.js"), Buffer.alloc(30))

  const result = cleanLegacyWebpackDevArtifacts({ devDir, log: () => {} })

  assert.deepEqual(result, { cleaned: false, sizeBytes: 0 })
  assert.equal(existsSync(devDir), true)
  rmSync(root, { recursive: true, force: true })
})

test("explicit all-cache cleanup removes dev output and production Webpack cache", () => {
  const root = tmpRoot()
  const nextDir = join(root, ".next")
  mkdirSync(join(nextDir, "dev"), { recursive: true })
  mkdirSync(join(nextDir, "cache", "webpack"), { recursive: true })
  mkdirSync(join(nextDir, "cache", "swc"), { recursive: true })
  writeFileSync(join(nextDir, "dev", "chunk.js"), Buffer.alloc(20))
  writeFileSync(join(nextDir, "cache", "webpack", "index.pack"), Buffer.alloc(30))
  writeFileSync(join(nextDir, "cache", "swc", "keep"), Buffer.alloc(10))

  const result = cleanAllNextCaches({ nextDir, log: () => {} })

  assert.deepEqual(result, { cleaned: true, sizeBytes: 50 })
  assert.equal(existsSync(join(nextDir, "dev")), false)
  assert.equal(existsSync(join(nextDir, "cache", "webpack")), false)
  assert.equal(existsSync(join(nextDir, "cache", "swc", "keep")), true)
  rmSync(root, { recursive: true, force: true })
})
