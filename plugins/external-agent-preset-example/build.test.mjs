/** @jest-environment node */
// `.test.mjs` files are discovered by the jsdom project, but esbuild's
// TextEncoder realm invariant cannot hold there — pin this suite to node.
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { test } from "@jest/globals"
import JSZip from "jszip"
import { buildPlugin } from "./build.mjs"

/**
 * Evaluate a bundle under the host's CommonJS contract. The SDK root and its
 * published subpaths are the only modules the host supplies; any other
 * unbundled dependency fails here.
 */
function evaluate(code, sdk) {
  const pluginModule = { exports: {} }
  runInNewContext(code, {
    module: pluginModule,
    exports: pluginModule.exports,
    require: (id) => {
      if (id === "@cognia/plugin-sdk" || id.startsWith("@cognia/plugin-sdk/")) return sdk(id)
      throw new Error(`Unexpected runtime dependency: ${id}`)
    },
  })
  return pluginModule.exports
}

const identitySdk = () => ({
  definePlugin: (definition) => definition,
  definePluginManifest: (manifest) => manifest,
  // The adapter extends the SDK's base class; a bare stand-in is enough to
  // prove the bundle loads and exports its factory.
  BaseProtocolAdapter: class {},
})

test("the install ZIP carries every entry the manifest names", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "cognia-external-agent-preset-example-"))
  try {
    const { archivePath, entryPaths } = await buildPlugin({ outputDirectory })
    const archiveBytes = await readFile(archivePath)
    const archive = await JSZip.loadAsync(archiveBytes)
    assert.deepEqual(Object.keys(archive.files).sort(), [
      "dist/context-provider.js",
      "dist/index.js",
      "plugin.json",
    ])

    const manifest = JSON.parse(await archive.file("plugin.json").async("string"))
    const declared = [
      manifest.main,
      ...Object.values(manifest.runtimeCompatibility)
        .filter((runtime) => runtime.availability === "supported")
        .map((runtime) => runtime.entrypoint),
      ...(manifest.externalAgentAdapters ?? []).map((adapter) => adapter.entry),
      ...(manifest.contextProviders ?? []).map((provider) => provider.entry),
    ]
    for (const path of declared) assert.ok(archive.file(path), `${path} is not in the ZIP`)

    const entry = await archive.file(manifest.main).async("string")
    assert.equal(entry, await readFile(entryPaths["dist/index.js"], "utf8"))
    const pluginModule = evaluate(entry, identitySdk)
    assert.deepEqual(JSON.parse(JSON.stringify(pluginModule.default.manifest)), manifest)
    assert.equal(await pluginModule.default.activate({}), undefined)

    const lazy = evaluate(
      await archive.file("dist/context-provider.js").async("string"),
      identitySdk
    )
    assert.equal(typeof lazy.createEnvBannerProvider, "function")

    await buildPlugin({ outputDirectory })
    assert.deepEqual(await readFile(archivePath), archiveBytes)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})
