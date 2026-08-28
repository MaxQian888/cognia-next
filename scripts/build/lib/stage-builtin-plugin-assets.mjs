// Stage the generated browser built-in plugin chunks into a CLI/brain layout.
//
// `build-browser-builtin-plugins.mjs` compiles five built-ins
// (`cognia-office`, `cognia-pdf`, `cognia-documents`, `cognia-presentations`,
// `cognia-visualize`) out of the app bundle and into
// `public/_cognia/builtin-plugins/`, recording each chunk's URL + SHA-256 in
// `lib/plugin/core/browser-builtin-assets.generated.json`. The web and Tauri
// shells serve that tree; the CLI/brain layouts had no equivalent step, so the
// loader's `fetch("/_cognia/…")` had nothing to hit even before Node rejected
// the root-relative URL outright.
//
// The tree keeps its URL shape (`_cognia/builtin-plugins/<id>/<sha>.cjs`)
// because `resolveBuiltinAssetRoot` in `cli/src/plugin/builtin-asset-fetcher.ts`
// resolves a chunk by joining the catalog URL onto the staged root.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/** Relative directory the chunks live under, in `public/` and in a layout alike. */
export const BUILTIN_PLUGIN_ASSET_DIR = path.join("_cognia", "builtin-plugins")

const CATALOG_RELATIVE = path.join("lib", "plugin", "core", "browser-builtin-assets.generated.json")
const GENERATOR_RELATIVE = path.join("scripts", "build", "build-browser-builtin-plugins.mjs")

/**
 * Copy `public/_cognia/builtin-plugins/` into `<outDir>/_cognia/builtin-plugins/`
 * and verify every catalog entry against the digest the app bundle pins.
 *
 * The digest is checked HERE, not only at runtime, because the two failures are
 * not equally recoverable: a stale chunk caught at build time is a forgotten
 * `pnpm plugin:builtin:build`, while the same chunk shipped is a host on which
 * those built-ins refuse with an integrity mismatch for the life of the
 * release. Throws on a missing tree, a missing chunk, or a mismatch.
 *
 * Returns the staged directory and the ids staged, so the caller can log what
 * shipped.
 */
export function stageBuiltinPluginAssets({ root, outDir, fsImpl = fs, buildChunks } = {}) {
  if (!root) throw new Error("stageBuiltinPluginAssets: `root` is required")
  if (!outDir) throw new Error("stageBuiltinPluginAssets: `outDir` is required")

  const sourceDir = path.join(root, "public", BUILTIN_PLUGIN_ASSET_DIR)
  // The chunk tree is generated and git-ignored, so a clean checkout (CI, the
  // Docker brain stage) legitimately has none. Build it rather than fail: the
  // CLI build is the only consumer that would otherwise need a separate,
  // easily-forgotten ordering constraint in every pipeline.
  if (!fsImpl.existsSync(sourceDir)) {
    const build =
      buildChunks ??
      (() =>
        execFileSync(process.execPath, [path.join(root, GENERATOR_RELATIVE)], {
          cwd: root,
          stdio: "inherit",
        }))
    build()
  }
  if (!fsImpl.existsSync(sourceDir)) {
    throw new Error(
      `stageBuiltinPluginAssets: missing ${path.join("public", BUILTIN_PLUGIN_ASSET_DIR)} after \`pnpm plugin:builtin:build\`. Without it the generated built-in plugins cannot be enabled on a CLI or brain host.`
    )
  }

  const catalogPath = path.join(root, CATALOG_RELATIVE)
  let entries
  try {
    entries = JSON.parse(fsImpl.readFileSync(catalogPath, "utf8"))?.entries
  } catch (error) {
    throw new Error(`stageBuiltinPluginAssets: ${CATALOG_RELATIVE} is not readable JSON: ${String(error)}`)
  }
  if (!entries || typeof entries !== "object") {
    throw new Error(`stageBuiltinPluginAssets: ${CATALOG_RELATIVE} has no \`entries\` map`)
  }

  const stagedDir = path.join(outDir, BUILTIN_PLUGIN_ASSET_DIR)
  fsImpl.rmSync(stagedDir, { recursive: true, force: true })
  fsImpl.mkdirSync(path.dirname(stagedDir), { recursive: true })
  fsImpl.cpSync(sourceDir, stagedDir, { recursive: true, dereference: true })

  const pluginIds = []
  for (const [pluginId, entry] of Object.entries(entries)) {
    const asset = entry?.asset
    // A built-in registered without an asset is bundled statically; nothing to
    // stage for it, and its absence here is not an error.
    if (!asset?.url) continue
    const staged = path.join(outDir, ...asset.url.slice(1).split("/"))
    if (!fsImpl.existsSync(staged)) {
      throw new Error(
        `stageBuiltinPluginAssets: ${pluginId} chunk ${asset.url} is absent from ${path.join("public", BUILTIN_PLUGIN_ASSET_DIR)} — the catalog and the built tree disagree; run \`pnpm plugin:builtin:build\`.`
      )
    }
    const actual = createHash("sha256").update(fsImpl.readFileSync(staged)).digest("hex")
    if (actual !== asset.sha256) {
      throw new Error(
        `stageBuiltinPluginAssets: ${pluginId} chunk does not match the digest the bundle pins\n  expected ${asset.sha256}\n  found    ${actual}\n  run: pnpm plugin:builtin:build`
      )
    }
    pluginIds.push(pluginId)
  }

  return { dir: stagedDir, pluginIds }
}
