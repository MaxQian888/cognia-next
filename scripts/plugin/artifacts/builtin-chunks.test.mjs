import assert from "node:assert/strict"
import { test } from "node:test"

import {
  BROWSER_BUILTIN_PLUGIN_IDS,
  PREBOOT_MANIFEST_FIELDS,
  buildBrowserBuiltinPlugins,
  prebootManifestSnapshot,
  stageBuiltinPluginIcons,
} from "./builtin-chunks.mjs"

test("curates every builtin as an independent asset", () => {
  assert.equal(BROWSER_BUILTIN_PLUGIN_IDS.length, 58)
  assert.equal(new Set(BROWSER_BUILTIN_PLUGIN_IDS).size, BROWSER_BUILTIN_PLUGIN_IDS.length)
  assert.ok(BROWSER_BUILTIN_PLUGIN_IDS.includes("github-comment-bot"))
  assert.ok(BROWSER_BUILTIN_PLUGIN_IDS.includes("clipboard-tools"))
  assert.ok(BROWSER_BUILTIN_PLUGIN_IDS.includes("ui-surface-reference"))
  assert.ok(BROWSER_BUILTIN_PLUGIN_IDS.includes("cognia-pdf"))
  assert.ok(BROWSER_BUILTIN_PLUGIN_IDS.includes("remote-desktop-vnc"))
  assert.ok(BROWSER_BUILTIN_PLUGIN_IDS.includes("remote-desktop-rustdesk"))
  assert.ok(BROWSER_BUILTIN_PLUGIN_IDS.includes("remote-desktop-web-console"))
})

import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  utimes,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { createHash } from "node:crypto"

test("stages and integrity-pins independently importable library CJS entries", async (t) => {
  const f = await fixture(t)
  const pluginRoot = path.join(f.root, "plugins/cognia-pdf")
  const manifest = {
    id: "cognia-pdf",
    version: "1",
    main: "src/index.ts",
    library: { modules: { utils: { entry: "src/utils.cjs" } } },
  }
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify(manifest))
  await writeFile(
    path.join(pluginRoot, "src/index.ts"),
    `export default {manifest: ${JSON.stringify(manifest)}, activate() {}}`
  )
  await writeFile(
    path.join(pluginRoot, "src/utils.cjs"),
    "module.exports=()=>({exports:{value:42}})"
  )
  const entry = (await f.run())["cognia-pdf"]
  const modulePath = entry.manifest.library.modules.utils.entry
  const bytes = await readFile(path.join(f.chunk(entry.asset.resourcesUrl), modulePath))
  assert.equal(
    entry.asset.entryHashes[modulePath],
    createHash("sha256").update(bytes).digest("hex")
  )
})

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
    JSON.stringify({ id: "cognia-pdf", version: "1", main: "src/index.ts" })
  )
  await writeFile(path.join(root, "plugins/cognia-pdf/src/value.ts"), "export const value = 1")
  await writeFile(
    path.join(root, "plugins/cognia-pdf/src/index.ts"),
    'import { value } from "./value"; export const worker = typeof __COGNIA_PDF_WORKER_URL__ === "undefined" ? "metadata" : __COGNIA_PDF_WORKER_URL__; export { value }; export default { manifest: { id: "cognia-pdf", version: "1", main: "src/index.ts" }, activate() {} }'
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
  const outDir = path.join(root, "set")
  const run = () => buildBrowserBuiltinPlugins({ ...options, outDir })
  // Chunk URLs are host URLs; inside the set they live under builtin-plugins/.
  const chunk = (url) => path.join(outDir, url.replace(/^\/_cognia\//, ""))
  return { root, outDir, run, chunk, calls: () => calls }
}

test("a verified cache hit preserves bundle, worker and index mtimes", async (t) => {
  const f = await fixture(t)
  const entries = await f.run()
  const index = path.join(f.outDir, "browser-builtin-assets.json")
  const bundle = f.chunk(entries["cognia-pdf"].asset.url)
  const workerDir = path.join(f.outDir, "builtin-plugins/_shared")
  const worker = path.join(workerDir, (await readdir(workerDir))[0])
  const files = [index, bundle, worker]
  for (const file of files) await utimes(file, 1000, 1000)
  assert.deepEqual(await f.run(), entries)
  assert.equal(f.calls(), 1)
  for (const file of files) assert.equal((await stat(file)).mtimeMs, 1000000)
})

test("stages packaged icons for static built-ins and refreshes them on a chunk cache hit", async (t) => {
  const f = await fixture(t)
  const dir = path.join(f.root, "plugins/browser-tools")
  await mkdir(path.join(dir, "assets"), { recursive: true })
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "cognia-browser-tools", icon: "assets/icon.png" })
  )
  await writeFile(path.join(dir, "assets/icon.png"), "first image")
  await f.run()
  const target = path.join(f.outDir, "plugin-icons/cognia-browser-tools/assets/icon.png")
  assert.equal(await readFile(target, "utf8"), "first image")
  await writeFile(path.join(dir, "assets/icon.png"), "updated image")
  await f.run()
  assert.equal(await readFile(target, "utf8"), "updated image")
  assert.equal(f.calls(), 1)
})

test("rejects missing packaged icons and paths escaping the plugin root", async (t) => {
  const f = await fixture(t)
  const manifest = path.join(f.root, "plugins/cognia-pdf/plugin.json")
  await writeFile(manifest, JSON.stringify({ id: "cognia-pdf", icon: "../outside.png" }))
  await assert.rejects(
    stageBuiltinPluginIcons({
      pluginsRoot: path.join(f.root, "plugins"),
      outDir: path.join(f.outDir, "plugin-icons"),
    }),
    /outside plugin root/
  )
  await writeFile(manifest, JSON.stringify({ id: "cognia-pdf", icon: "assets/missing.png" }))
  await assert.rejects(
    stageBuiltinPluginIcons({
      pluginsRoot: path.join(f.root, "plugins"),
      outDir: path.join(f.outDir, "plugin-icons"),
    }),
    /ENOENT/
  )
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
  const bundle = f.chunk(entries["cognia-pdf"].asset.url)
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
  const index = path.join(f.outDir, "browser-builtin-assets.json")
  const previousIndex = await readFile(index, "utf8")
  await writeFile(
    path.join(f.root, "plugins/cognia-pdf/src/value.ts"),
    'export { secret as value } from "@/lib/private"'
  )
  await assert.rejects(f.run(), /host-private module/)
  assert.equal(await readFile(index, "utf8"), previousIndex)
  assert.ok(await stat(f.chunk(entries["cognia-pdf"].asset.url)))
})

test("a cache hit still removes unreferenced output files and corrupt index files are repaired", async (t) => {
  const f = await fixture(t)
  const entries = await f.run()
  const orphan = path.join(f.outDir, "builtin-plugins/obsolete.cjs")
  await writeFile(orphan, "stale")
  await f.run()
  assert.equal(f.calls(), 1)
  await assert.rejects(stat(orphan), { code: "ENOENT" })
  const index = path.join(f.outDir, "browser-builtin-assets.json")
  await writeFile(index, "invalid index")
  assert.deepEqual(await f.run(), entries)
  assert.equal(f.calls(), 2)
})

test("the preboot snapshot keeps only pre-boot fields, for plugins that declare one", () => {
  assert.deepEqual(PREBOOT_MANIFEST_FIELDS, ["dexie", "characterPacks"])
  const dexie = { tables: [{ name: "items", schema: "++id" }] }
  const pack = { id: "pack", name: "Pack", version: "1.0.0", characters: [] }
  assert.deepEqual(
    prebootManifestSnapshot({
      "z-tables": { manifest: { id: "z-tables", version: "2", main: "x", dexie } },
      plain: { manifest: { id: "plain", version: "1", main: "x" } },
      "a-pack": { manifest: { id: "a-pack", version: "3", characterPacks: [pack], skills: [] } },
    }),
    {
      version: 1,
      plugins: {
        "a-pack": { version: "3", characterPacks: [pack] },
        "z-tables": { version: "2", dexie },
      },
    }
  )
})

test("writes the preboot snapshot beside the index and repairs it on a cache hit", async (t) => {
  const f = await fixture(t)
  const manifest = {
    id: "cognia-pdf",
    version: "1",
    main: "src/index.ts",
    dexie: { tables: [{ name: "docs", schema: "++id" }] },
  }
  await writeFile(path.join(f.root, "plugins/cognia-pdf/plugin.json"), JSON.stringify(manifest))
  await writeFile(
    path.join(f.root, "plugins/cognia-pdf/src/index.ts"),
    `export default { manifest: ${JSON.stringify(manifest)}, activate() {} }`
  )
  await f.run()
  const snapshot = path.join(f.outDir, "builtin-preboot-manifests.json")
  const expected = {
    version: 1,
    plugins: { "cognia-pdf": { version: "1", dexie: manifest.dexie } },
  }
  assert.deepEqual(JSON.parse(await readFile(snapshot, "utf8")), expected)
  await rm(snapshot)
  await f.run()
  assert.equal(f.calls(), 2)
  assert.deepEqual(JSON.parse(await readFile(snapshot, "utf8")), expected)
})

test("builds from plugin sources that live outside the toolchain root", async (t) => {
  const f = await fixture(t)
  const external = await mkdtemp(path.join(tmpdir(), "browser-builtin-sources-"))
  t.after(() => rm(external, { recursive: true, force: true }))
  await cp(path.join(f.root, "plugins"), external, { recursive: true })
  await rm(path.join(f.root, "plugins"), { recursive: true })
  const entries = await buildBrowserBuiltinPlugins({
    root: f.root,
    pluginsRoot: external,
    pluginIds: ["cognia-pdf"],
    bundle: build,
    outDir: f.outDir,
  })
  assert.equal(entries["cognia-pdf"].manifest.id, "cognia-pdf")
  assert.ok(await stat(f.chunk(entries["cognia-pdf"].asset.url)))
})

test("an icon a plugin stopped shipping is removed from the set", async (t) => {
  const f = await fixture(t)
  const dir = path.join(f.root, "plugins/browser-tools")
  await mkdir(path.join(dir, "assets"), { recursive: true })
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "cognia-browser-tools", icon: "assets/icon.png" })
  )
  await writeFile(path.join(dir, "assets/icon.png"), "image")
  await f.run()
  const target = path.join(f.outDir, "plugin-icons/cognia-browser-tools/assets/icon.png")
  assert.ok(await stat(target))
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "cognia-browser-tools" }))
  await f.run()
  await assert.rejects(stat(target), { code: "ENOENT" })
  await assert.rejects(stat(path.join(f.outDir, "plugin-icons/cognia-browser-tools")), {
    code: "ENOENT",
  })
})

test("plugin.json fields the module manifest omits survive into the shipped manifest", async (t) => {
  const f = await fixture(t)
  const base = {
    id: "cognia-pdf",
    version: "1",
    main: "src/index.ts",
    activationEvents: ["startup", "onCommand:pdf"],
    description: "from plugin.json",
  }
  await writeFile(path.join(f.root, "plugins/cognia-pdf/plugin.json"), JSON.stringify(base))
  await writeFile(
    path.join(f.root, "plugins/cognia-pdf/src/index.ts"),
    'export default { manifest: { id: "cognia-pdf", version: "1", main: "src/index.ts", skills: [] }, activate() {} }'
  )
  const entries = await f.run()
  assert.deepEqual(entries["cognia-pdf"].manifest.activationEvents, ["startup", "onCommand:pdf"])
  assert.equal(entries["cognia-pdf"].manifest.description, "from plugin.json")
  assert.deepEqual(entries["cognia-pdf"].manifest.skills, [])
})
