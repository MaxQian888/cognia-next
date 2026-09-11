import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
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

    // Match the host's CommonJS contract; any unbundled dependency fails here.
    const pluginModule = { exports: {} }
    runInNewContext(entry, {
      module: pluginModule,
      exports: pluginModule.exports,
      require: (id) => {
        throw new Error(`Unexpected runtime dependency: ${id}`)
      },
    })
    assert.deepEqual(JSON.parse(JSON.stringify(pluginModule.exports.default.manifest)), manifest)
    assert.equal(await pluginModule.exports.default.activate({}), undefined)

    await buildPlugin({ outputDirectory })
    assert.deepEqual(await readFile(archivePath), archiveBytes)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})
