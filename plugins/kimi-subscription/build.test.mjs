/** @jest-environment node */
// `.test.mjs` files are discovered by the jsdom project, but esbuild's
// TextEncoder realm invariant cannot hold there — pin this suite to node.
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "@jest/globals"
import { runInNewContext } from "node:vm"
import JSZip from "jszip"
import { buildPlugin } from "./build.mjs"

test("the install ZIP contains a standalone executable entry and its declared files", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "cognia-kimi-plugin-"))
  try {
    const { archivePath, entryPath } = await buildPlugin({ outputDirectory })
    const archiveBytes = await readFile(archivePath)
    const archive = await JSZip.loadAsync(archiveBytes)
    assert.deepEqual(Object.keys(archive.files).sort(), [
      "README.md",
      "README.zh-CN.md",
      "dist/index.js",
      "plugin.json",
    ])
    const manifest = JSON.parse(await archive.file("plugin.json").async("string"))
    const entry = await archive.file(manifest.main).async("string")
    assert.equal(entry, await readFile(entryPath, "utf8"))
    for (const path of manifest.bundle_include) assert.ok(archive.file(path))
    for (const runtime of Object.values(manifest.runtimeCompatibility)) {
      if (runtime.availability === "supported") assert.ok(archive.file(runtime.entrypoint))
    }

    // Match the host's CommonJS contract: the SDK is the one shared module the
    // entry may require (the host supplies it); any other unbundled dependency
    // fails here. `definePlugin` / `definePluginManifest` are identity seams.
    const required = []
    const pluginModule = { exports: {} }
    runInNewContext(entry, {
      module: pluginModule,
      exports: pluginModule.exports,
      require: (id) => {
        required.push(id)
        if (id === "@cognia/plugin-sdk") {
          return { definePlugin: (definition) => definition, definePluginManifest: (m) => m }
        }
        throw new Error(`Unexpected runtime dependency: ${id}`)
      },
    })
    assert.deepEqual(required, ["@cognia/plugin-sdk"])
    assert.deepEqual(JSON.parse(JSON.stringify(pluginModule.exports.default.manifest)), manifest)
    assert.equal(await pluginModule.exports.default.activate({}), undefined)

    await buildPlugin({ outputDirectory })
    assert.deepEqual(await readFile(archivePath), archiveBytes)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})
