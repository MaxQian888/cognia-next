/** @jest-environment node */
// `.test.mjs` files are discovered by the jsdom project, but esbuild's
// TextEncoder realm invariant cannot hold there — pin this suite to node.
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "@jest/globals"
import JSZip from "jszip"
import { buildPlugin, evaluateBundle } from "./build.mjs"

const pluginRoot = dirname(fileURLToPath(import.meta.url))

test("the install ZIP carries a CommonJS entry that only needs the host-shared SDK", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "cognia-devin-plugin-"))
  try {
    const { archivePath, entryPath, manifestPath } = await buildPlugin({
      outputDirectory,
      pack: true,
    })
    const archiveBytes = await readFile(archivePath)
    const archive = await JSZip.loadAsync(archiveBytes)
    assert.deepEqual(Object.keys(archive.files).sort(), [
      "README.md",
      "assets/icon.png",
      "dist/index.js",
      "plugin.json",
    ])

    const manifest = JSON.parse(await archive.file("plugin.json").async("string"))
    assert.equal(
      (await archive.file(manifest.icon).async("nodebuffer")).subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a"
    )
    assert.deepEqual(manifest, JSON.parse(await readFile(manifestPath, "utf8")))
    // The regenerated manifest is the committed one: the build is a fixed point.
    assert.deepEqual(manifest, JSON.parse(await readFile(join(pluginRoot, "plugin.json"), "utf8")))
    for (const runtime of Object.values(manifest.runtimeCompatibility)) {
      if (runtime.availability === "supported") assert.ok(archive.file(runtime.entrypoint))
    }

    const entry = await archive.file(manifest.main).async("string")
    assert.equal(entry, await readFile(entryPath, "utf8"))
    assert.ok(!entry.includes(pluginRoot), "install bundle must not embed the checkout path")
    // evaluateBundle throws for any require but `@cognia/plugin-sdk`.
    const pluginModule = evaluateBundle(entry)
    assert.deepEqual(JSON.parse(JSON.stringify(pluginModule.default.manifest)), manifest)
    assert.equal(typeof pluginModule.githubDevinBot, "function")
    assert.equal(typeof pluginModule.default.activate, "function")

    await buildPlugin({ outputDirectory, pack: true })
    assert.deepEqual(await readFile(archivePath), archiveBytes)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

test("the committed install ZIP matches a fresh build", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "cognia-devin-plugin-"))
  try {
    const { archivePath } = await buildPlugin({ outputDirectory, pack: true })
    const fresh = await JSZip.loadAsync(await readFile(archivePath))
    const committed = await JSZip.loadAsync(
      await readFile(join(pluginRoot, "github-devin-bot.zip"))
    )
    assert.deepEqual(Object.keys(committed.files).sort(), Object.keys(fresh.files).sort())
    assert.deepEqual(
      await committed.file("assets/icon.png").async("nodebuffer"),
      await fresh.file("assets/icon.png").async("nodebuffer")
    )
    assert.deepEqual(
      JSON.parse(await committed.file("plugin.json").async("string")),
      JSON.parse(await fresh.file("plugin.json").async("string"))
    )
    for (const name of ["dist/index.js", "README.md"]) {
      assert.equal(
        await committed.file(name).async("string"),
        await fresh.file(name).async("string"),
        `${name} in github-devin-bot.zip is stale; run pnpm --dir plugins/github-devin-bot pack:plugin`
      )
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})
