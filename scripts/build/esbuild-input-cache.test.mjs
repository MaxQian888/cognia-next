import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import {
  captureBuildInputs,
  isBuildCacheFresh,
  readBuildCache,
  saveBuildCache,
} from "./esbuild-input-cache.mjs"

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "esbuild-input-cache-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src/index.ts"), "export const value = 1")
  writeFileSync(path.join(root, "generator.mjs"), "generator-v1")
  writeFileSync(path.join(root, "output.js"), "output")
  const cacheFile = path.join(root, "cache.json")
  const output = path.join(root, "output.js")
  const save = () =>
    saveBuildCache(cacheFile, {
      root,
      key: "build-options",
      inputs: ["src/index.ts"],
      extraFiles: ["generator.mjs"],
      outputs: [output],
      startedAt: performance.timeOrigin + performance.now(),
    })
  const fresh = () => isBuildCacheFresh(readBuildCache(cacheFile), root, "build-options", [output])
  return { root, cacheFile, output, save, fresh }
}

test("fingerprints the compiler package, generator, lock and recursive JSONC tsconfig chain", (t) => {
  const f = fixture(t)
  writeFileSync(
    path.join(f.root, "tsconfig.json"),
    '{ // comment\n "extends": "./base.json", "compilerOptions": {}, }'
  )
  writeFileSync(path.join(f.root, "base.json"), '{"extends":"./base2.json"}')
  writeFileSync(path.join(f.root, "base2.json"), '{"compilerOptions":{"jsx":"react-jsx"}}')
  const inputs = captureBuildInputs(f.root, ["src/index.ts"], ["generator.mjs"])
  assert.equal(
    typeof inputs.files[createRequire(import.meta.url).resolve("esbuild/package.json")],
    "string"
  )
  assert.equal(typeof inputs.files[path.join(f.root, "base2.json")], "string")
  assert.equal(inputs.files[path.join(f.root, "pnpm-lock.yaml")], null)
  f.save()
  assert.equal(f.fresh(), true)
  writeFileSync(path.join(f.root, "base2.json"), '{"compilerOptions":{"jsx":"preserve"}}')
  assert.equal(f.fresh(), false)
  f.save()
  writeFileSync(path.join(f.root, "generator.mjs"), "generator-v2")
  assert.equal(f.fresh(), false)
})

test("source siblings and package resolution metadata invalidate a previously valid graph", (t) => {
  const f = fixture(t)
  f.save()
  writeFileSync(path.join(f.root, "src/index.tsx"), "new higher-priority source")
  assert.equal(f.fresh(), false)
  f.save()
  writeFileSync(path.join(f.root, "src/package.json"), '{"type":"module"}')
  assert.equal(f.fresh(), false)
})

test("missing or corrupt records, removed sources, output tampering and option changes cannot hit", (t) => {
  const f = fixture(t)
  assert.equal(f.fresh(), false)
  writeFileSync(f.cacheFile, "broken json")
  assert.equal(f.fresh(), false)
  f.save()
  assert.equal(
    isBuildCacheFresh(readBuildCache(f.cacheFile), f.root, "new-options", [f.output]),
    false
  )
  writeFileSync(f.output, "tampered")
  assert.equal(f.fresh(), false)
  writeFileSync(f.output, "output")
  rmSync(path.join(f.root, "src/index.ts"))
  assert.equal(f.fresh(), false)
})

test("does not certify source bytes changed during a build", (t) => {
  const f = fixture(t)
  const saved = saveBuildCache(f.cacheFile, {
    root: f.root,
    key: "build-options",
    inputs: ["src/index.ts"],
    extraFiles: [],
    outputs: [f.output],
    startedAt: 0,
  })
  assert.equal(saved, false)
  assert.equal(readBuildCache(f.cacheFile), null)
})
