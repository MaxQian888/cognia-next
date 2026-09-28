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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  cleanStaleStorybookCaches,
  cleanWebpackIndexBackups,
  STORYBOOK_CACHE_DIRS,
} from "./clean-stale-webpack-cache.mjs"

function tmpRepoRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), "sb-cache-")))
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

test("backup cleanup removes only a retired index with a current replacement", () => {
  const repoRoot = tmpRepoRoot()
  try {
    const cache = join(repoRoot, ".next/cache/webpack")
    const current = join(cache, "client-production")
    const interrupted = join(cache, "server-production")
    mkdirSync(current, { recursive: true })
    mkdirSync(interrupted, { recursive: true })
    for (const name of ["index.pack", "0.pack", "index.pack_", "other.old"]) {
      writeFileSync(join(current, name), "keep")
    }
    writeFileSync(join(current, "index.pack.old"), "retired")
    writeFileSync(join(interrupted, "index.pack.old"), "keep without replacement")
    const result = cleanWebpackIndexBackups({ repoRoot, log: () => {} })
    assert.deepEqual(result, { removed: 1, sizeBytes: 7 })
    assert.equal(existsSync(join(current, "index.pack.old")), false)
    for (const name of ["index.pack", "0.pack", "index.pack_", "other.old"]) {
      assert.equal(existsSync(join(current, name)), true)
    }
    assert.equal(existsSync(join(interrupted, "index.pack.old")), true)
    assert.deepEqual(cleanWebpackIndexBackups({ repoRoot, log: () => {} }), {
      removed: 0,
      sizeBytes: 0,
    })
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("backup cleanup leaves missing caches and unrelated caches untouched", () => {
  const repoRoot = tmpRepoRoot()
  try {
    assert.deepEqual(cleanWebpackIndexBackups({ repoRoot }), { removed: 0, sizeBytes: 0 })
    const unrelated = join(repoRoot, "node_modules/.cache/webpack")
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(join(unrelated, "index.pack"), "current")
    writeFileSync(join(unrelated, "index.pack.old"), "old")
    cleanWebpackIndexBackups({ repoRoot })
    assert.equal(existsSync(join(unrelated, "index.pack.old")), true)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("backup cleanup never follows directory or file symlinks", () => {
  const repoRoot = tmpRepoRoot()
  try {
    const cache = join(repoRoot, ".next/cache/webpack")
    const external = join(repoRoot, "external")
    mkdirSync(cache, { recursive: true })
    mkdirSync(external)
    writeFileSync(join(external, "index.pack"), "current")
    writeFileSync(join(external, "index.pack.old"), "old")
    symlinkSync(external, join(cache, "linked-dir"), "dir")
    symlinkSync(join(external, "index.pack.old"), join(cache, "index.pack.old"))
    writeFileSync(join(cache, "index.pack"), "current")
    assert.deepEqual(cleanWebpackIndexBackups({ repoRoot }), { removed: 0, sizeBytes: 0 })
    assert.equal(existsSync(join(external, "index.pack.old")), true)
    rmSync(cache, { recursive: true })
    symlinkSync(external, cache, "dir")
    assert.deepEqual(cleanWebpackIndexBackups({ repoRoot }), { removed: 0, sizeBytes: 0 })
    assert.equal(existsSync(join(external, "index.pack.old")), true)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("--backups-only CLI dispatch preserves Storybook threshold caches", () => {
  const repoRoot = tmpRepoRoot()
  try {
    const scriptDirectory = join(repoRoot, "scripts/build")
    mkdirSync(scriptDirectory, { recursive: true })
    // Keep the real shared helper while running the CLI against a disposable root.
    const script = readFileSync(
      new URL("./clean-stale-webpack-cache.mjs", import.meta.url),
      "utf8"
    ).replace(
      '"./clean-stale-turbopack-cache.mjs"',
      JSON.stringify(new URL("./clean-stale-turbopack-cache.mjs", import.meta.url).href)
    )
    const scriptPath = join(scriptDirectory, "clean-stale-webpack-cache.mjs")
    writeFileSync(scriptPath, script)
    const cache = join(repoRoot, ".next/cache/webpack/client-production")
    const storybook = join(repoRoot, STORYBOOK_CACHE_DIRS[1])
    mkdirSync(cache, { recursive: true })
    mkdirSync(storybook, { recursive: true })
    writeFileSync(join(cache, "index.pack"), "current")
    writeFileSync(join(cache, "index.pack.old"), "old")
    writeFileSync(join(storybook, "keep.bin"), "keep")
    const child = spawnSync(process.execPath, [scriptPath, "--backups-only"], {
      encoding: "utf8",
      env: { ...process.env, WEBPACK_CACHE_MAX_GB: "0" },
    })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /removed 1 webpack index backups/)
    assert.equal(existsSync(join(cache, "index.pack.old")), false)
    assert.equal(existsSync(join(cache, "index.pack")), true)
    assert.equal(existsSync(join(storybook, "keep.bin")), true)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
