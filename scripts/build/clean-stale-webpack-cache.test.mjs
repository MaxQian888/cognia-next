/**
 * Regression coverage for scripts/build/clean-stale-webpack-cache.mjs.
 *
 * The per-dir purge logic is exported, so we exercise it directly against a
 * temp repo root. Threshold is passed in bytes, so an "over threshold" case
 * needs only a tiny file + a tiny threshold — no multi-GB fixtures.
 *
 * Run with: node --test scripts/build/clean-stale-webpack-cache.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { cleanStaleStorybookCaches, STORYBOOK_CACHE_DIRS } from "./clean-stale-webpack-cache.mjs"

function tmpRepoRoot() {
  return mkdtempSync(join(tmpdir(), "sb-cache-"))
}

test("covers both the webpack and storybook cache dirs", () => {
  assert.deepEqual(STORYBOOK_CACHE_DIRS, [
    join("node_modules", ".cache", "webpack"),
    join("node_modules", ".cache", "storybook"),
  ])
})

test("purges only the dirs over the threshold and labels each result", () => {
  const repoRoot = tmpRepoRoot()
  const [webpackRel, storybookRel] = STORYBOOK_CACHE_DIRS
  const webpackDir = join(repoRoot, webpackRel)
  const storybookDir = join(repoRoot, storybookRel)
  mkdirSync(join(webpackDir, "preview-development"), { recursive: true })
  mkdirSync(storybookDir, { recursive: true })
  writeFileSync(join(webpackDir, "preview-development", "0.pack"), Buffer.alloc(500))
  writeFileSync(join(storybookDir, "small.bin"), Buffer.alloc(50))

  const messages = []
  const results = cleanStaleStorybookCaches({
    repoRoot,
    thresholdBytes: 100,
    log: (m) => messages.push(m),
  })

  assert.equal(results.length, 2)
  assert.deepEqual(
    results.map((r) => ({ label: r.label, cleaned: r.cleaned, sizeBytes: r.sizeBytes })),
    [
      { label: webpackRel, cleaned: true, sizeBytes: 500 },
      { label: storybookRel, cleaned: false, sizeBytes: 50 },
    ]
  )
  assert.equal(existsSync(webpackDir), false)
  assert.equal(existsSync(storybookDir), true)
  assert.match(messages[0], /node_modules\/\.cache\/webpack .* purged/)
  assert.match(messages[1], /node_modules\/\.cache\/storybook .* kept/)
  rmSync(repoRoot, { recursive: true, force: true })
})

test("no-op and silent when neither cache dir exists", () => {
  const repoRoot = tmpRepoRoot()
  const messages = []
  const results = cleanStaleStorybookCaches({
    repoRoot,
    thresholdBytes: 100,
    log: (m) => messages.push(m),
  })

  assert.equal(results.length, 2)
  assert.ok(results.every((r) => r.cleaned === false && r.sizeBytes === 0))
  assert.equal(messages.length, 0)
  rmSync(repoRoot, { recursive: true, force: true })
})
