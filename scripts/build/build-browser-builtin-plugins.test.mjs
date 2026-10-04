import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BROWSER_BUILTIN_PLUGIN_IDS,
  buildBrowserBuiltinPlugins,
} from "./build-browser-builtin-plugins.mjs"

test("keeps the first migration batch explicit and deterministic", () => {
  assert.deepEqual(BROWSER_BUILTIN_PLUGIN_IDS, [
    "cognia-office",
    "cognia-pdf",
    "cognia-documents",
    "cognia-presentations",
    "cognia-visualize",
  ])
})

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "esbuild"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "browser-builtin-cache-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "plugins/cognia-pdf/src"), { recursive: true })
  await mkdir(path.join(root, "node_modules/pdfjs-dist/legacy/build"), { recursive: true })
  await writeFile(
    path.join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
    "export const worker = 1"
  )
  await writeFile(
    path.join(root, "plugins/cognia-pdf/plugin.json"),
    JSON.stringify({ id: "cognia-pdf", version: "1" })
  )
  await writeFile(path.join(root, "plugins/cognia-pdf/src/value.ts"), "export const value = 1")
  await writeFile(
    path.join(root, "plugins/cognia-pdf/src/index.ts"),
    'import { value } from "./value"; export const worker = __COGNIA_PDF_WORKER_URL__; export { value }'
  )
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'")
  let calls = 0
  const options = {
    root,
    pluginIds: ["cognia-pdf"],
    bundle: async (options) => {
      calls++
      return build(options)
    },
  }
  const run = () => buildBrowserBuiltinPlugins(options)
  return { root, run, calls: () => calls }
}

test("a verified cache hit preserves bundle, worker and index mtimes", async (t) => {
  const f = await fixture(t)
  const entries = await f.run()
  const index = path.join(f.root, "lib/plugin/core/browser-builtin-assets.generated.json")
  const bundle = path.join(f.root, "public", entries["cognia-pdf"].asset.url)
  const workerDir = path.join(f.root, "public/_cognia/builtin-plugins/_shared")
  const worker = path.join(workerDir, (await readdir(workerDir))[0])
  const files = [index, bundle, worker]
  for (const file of files) await utimes(file, 1000, 1000)
  assert.deepEqual(await f.run(), entries)
  assert.equal(f.calls(), 1)
  for (const file of files) assert.equal((await stat(file)).mtimeMs, 1000000)
})

test("transitive imports, lockfile, configuration and PDF worker changes rebuild", async (t) => {
  const f = await fixture(t)
  await f.run()
  for (const [relative, content] of [
    ["plugins/cognia-pdf/src/value.ts", "export const value = 2"],
    ["pnpm-lock.yaml", "lockfileVersion: '8.0'"],
    ["tsconfig.json", '{"compilerOptions":{"useDefineForClassFields":true}}'],
    ["node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "export const worker = 2"],
  ]) {
    const previous = f.calls()
    await writeFile(path.join(f.root, relative), content)
    await f.run()
    assert.equal(f.calls(), previous + 1, relative)
  }
})

test("missing or tampered generated files are repaired and obsolete hashes pruned", async (t) => {
  const f = await fixture(t)
  const entries = await f.run()
  const bundle = path.join(f.root, "public", entries["cognia-pdf"].asset.url)
  const original = await readFile(bundle, "utf8")
  await writeFile(bundle, "tampered")
  await f.run()
  assert.equal(await readFile(bundle, "utf8"), original)
  await rm(bundle)
  await f.run()
  assert.equal(await readFile(bundle, "utf8"), original)
  await writeFile(path.join(f.root, "plugins/cognia-pdf/src/value.ts"), "export const value = 99")
  const next = await f.run()
  assert.notEqual(next["cognia-pdf"].asset.url, entries["cognia-pdf"].asset.url)
  await assert.rejects(stat(bundle), { code: "ENOENT" })
})

test("a newly introduced host-private import still fails and preserves published assets", async (t) => {
  const f = await fixture(t)
  const entries = await f.run()
  const index = path.join(f.root, "lib/plugin/core/browser-builtin-assets.generated.json")
  const previousIndex = await readFile(index, "utf8")
  await writeFile(
    path.join(f.root, "plugins/cognia-pdf/src/value.ts"),
    'export { secret as value } from "@/lib/private"'
  )
  await assert.rejects(f.run(), /host-private module/)
  assert.equal(await readFile(index, "utf8"), previousIndex)
  assert.ok(await stat(path.join(f.root, "public", entries["cognia-pdf"].asset.url)))
})

test("a cache hit still removes unreferenced output files and corrupt index files are repaired", async (t) => {
  const f = await fixture(t)
  const entries = await f.run()
  const orphan = path.join(f.root, "public/_cognia/builtin-plugins/obsolete.cjs")
  await writeFile(orphan, "stale")
  await f.run()
  assert.equal(f.calls(), 1)
  await assert.rejects(stat(orphan), { code: "ENOENT" })
  const index = path.join(f.root, "lib/plugin/core/browser-builtin-assets.generated.json")
  await writeFile(index, "invalid index")
  assert.deepEqual(await f.run(), entries)
  assert.equal(f.calls(), 2)
})
