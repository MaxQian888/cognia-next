import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  BUILTIN_PLUGIN_ASSET_DIR,
  stageBuiltinPluginAssets,
} from "./stage-builtin-plugin-assets.mjs"

const CHUNK = "module.exports = { activate() {} }\n"
const DIGEST = createHash("sha256").update(CHUNK).digest("hex")
const URL_PATH = `/_cognia/builtin-plugins/cognia-visualize/${DIGEST}.cjs`

/** A throwaway repo root with one generated chunk and a matching catalog. */
function makeRoot({ chunk = CHUNK, sha256 = DIGEST, writeChunk = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stage-builtin-plugins-"))
  if (writeChunk) {
    const dir = join(root, "public", BUILTIN_PLUGIN_ASSET_DIR, "cognia-visualize")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${DIGEST}.cjs`), chunk)
  }
  const catalogDir = join(root, "lib", "plugin", "core")
  mkdirSync(catalogDir, { recursive: true })
  writeFileSync(
    join(catalogDir, "browser-builtin-assets.generated.json"),
    JSON.stringify({
      entries: {
        "cognia-visualize": { asset: { url: URL_PATH, sha256, sharedModules: [] } },
      },
    })
  )
  return root
}

test("stages the chunk tree under the URL path the loader resolves", () => {
  const root = makeRoot()
  const outDir = mkdtempSync(join(tmpdir(), "stage-builtin-plugins-out-"))

  const result = stageBuiltinPluginAssets({ root, outDir })

  assert.deepEqual(result.pluginIds, ["cognia-visualize"])
  assert.equal(result.dir, join(outDir, BUILTIN_PLUGIN_ASSET_DIR))
  assert.equal(readFileSync(join(outDir, URL_PATH.slice(1)), "utf8"), CHUNK)
})

test("builds the tree when a clean checkout has none", () => {
  const root = makeRoot({ writeChunk: false })
  const outDir = mkdtempSync(join(tmpdir(), "stage-builtin-plugins-out-"))
  let built = 0

  stageBuiltinPluginAssets({
    root,
    outDir,
    buildChunks: () => {
      built += 1
      const dir = join(root, "public", BUILTIN_PLUGIN_ASSET_DIR, "cognia-visualize")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${DIGEST}.cjs`), CHUNK)
    },
  })

  assert.equal(built, 1)
  assert.ok(existsSync(join(outDir, URL_PATH.slice(1))))
})

test("refuses a chunk that does not match the digest the bundle pins", () => {
  const root = makeRoot({ sha256: "0".repeat(64) })
  const outDir = mkdtempSync(join(tmpdir(), "stage-builtin-plugins-out-"))

  assert.throws(
    () => stageBuiltinPluginAssets({ root, outDir }),
    /does not match the digest/
  )
})

test("refuses a catalog entry with no chunk in the built tree", () => {
  const root = makeRoot()
  const catalog = join(root, "lib", "plugin", "core", "browser-builtin-assets.generated.json")
  writeFileSync(
    catalog,
    JSON.stringify({
      entries: {
        "cognia-visualize": { asset: { url: URL_PATH, sha256: DIGEST, sharedModules: [] } },
        "cognia-pdf": {
          asset: { url: "/_cognia/builtin-plugins/cognia-pdf/missing.cjs", sha256: DIGEST },
        },
      },
    })
  )
  const outDir = mkdtempSync(join(tmpdir(), "stage-builtin-plugins-out-"))

  assert.throws(() => stageBuiltinPluginAssets({ root, outDir }), /is absent from/)
})

test("skips statically-bundled built-ins that carry no asset", () => {
  const root = makeRoot()
  const catalog = join(root, "lib", "plugin", "core", "browser-builtin-assets.generated.json")
  writeFileSync(
    catalog,
    JSON.stringify({
      entries: {
        "cognia-visualize": { asset: { url: URL_PATH, sha256: DIGEST, sharedModules: [] } },
        "clipboard-tools": { path: "builtin://clipboard-tools" },
      },
    })
  )
  const outDir = mkdtempSync(join(tmpdir(), "stage-builtin-plugins-out-"))

  assert.deepEqual(stageBuiltinPluginAssets({ root, outDir }).pluginIds, ["cognia-visualize"])
})

test("requires both a root and an out directory", () => {
  assert.throws(() => stageBuiltinPluginAssets({ outDir: "/tmp/x" }), /`root` is required/)
  assert.throws(() => stageBuiltinPluginAssets({ root: "/tmp/x" }), /`outDir` is required/)
})
