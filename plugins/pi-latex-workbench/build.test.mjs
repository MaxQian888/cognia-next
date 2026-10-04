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
import { assertBundleAllowlist, buildPlugin } from "./build.mjs"

test("the install ZIP holds exactly plugin.json, the entry and the allowlist", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "cognia-pi-latex-workbench-plugin-"))
  try {
    const { archivePath, entryPath } = await buildPlugin({ outputDirectory })
    const archiveBytes = await readFile(archivePath)
    const archive = await JSZip.loadAsync(archiveBytes)
    const manifest = JSON.parse(await archive.file("plugin.json").async("string"))
    const names = Object.keys(archive.files).sort()
    assert.deepEqual(names, ["plugin.json", manifest.main, ...manifest.bundle_include].sort())

    // The snapshot, the hosted-session glue and the skills travel; local-only
    // state never does.
    assert.ok(names.includes("vendor/packages/cli/src/bin.ts"))
    assert.ok(names.includes("vendor/package-lock.json"))
    assert.ok(names.includes("pi/cognia-workbench.ts"))
    assert.ok(names.includes("skills/latex-workbench/SKILL.md"))
    for (const name of names) {
      assert.ok(!name.split("/").includes("node_modules"), name)
      assert.ok(!name.split("/").includes(".latexwb"), name)
      assert.ok(!/\.(test|spec)\.[cm]?[jt]sx?$/.test(name), name)
      assert.ok(!name.startsWith("vendor/runtime/toolchain/"), name)
      assert.ok(!name.startsWith("scripts/"), name)
    }

    // Vendored bytes are copied verbatim.
    assert.deepEqual(
      await archive.file("vendor/packages/cli/src/bin.ts").async("nodebuffer"),
      await readFile(new URL("./vendor/packages/cli/src/bin.ts", import.meta.url))
    )

    const entry = await archive.file(manifest.main).async("string")
    assert.equal(entry, await readFile(entryPath, "utf8"))
    // Match the host's CommonJS contract: the SDK is the one host-shared
    // module the bundle may require.
    const hostSdk = { definePlugin: (definition) => definition, definePluginManifest: (m) => m }
    const pluginModule = { exports: {} }
    runInNewContext(entry, {
      module: pluginModule,
      exports: pluginModule.exports,
      require: (id) => {
        if (id === "@cognia/plugin-sdk") return hostSdk
        throw new Error(`Unexpected runtime dependency: ${id}`)
      },
    })
    assert.deepEqual(JSON.parse(JSON.stringify(pluginModule.exports.default.manifest)), manifest)
    assert.equal(await pluginModule.exports.default.activate({}), undefined)

    // Deterministic: a rebuild is byte-identical.
    await buildPlugin({ outputDirectory })
    assert.deepEqual(await readFile(archivePath), archiveBytes)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

test("the allowlist guard refuses escapes and local-only state", () => {
  assert.doesNotThrow(() => assertBundleAllowlist(["README.md", "vendor/packages/cli/src/bin.ts"]))
  for (const bad of [
    "/etc/passwd",
    "C:/x",
    "vendor/../../x",
    "vendor/node_modules/ajv/index.js",
    "vendor/runtime/toolchain/bundle/x",
    "vendor/runtime/render/bin/helper",
    ".latexwb/workbench.db",
    "dist/index.js",
  ]) {
    assert.throws(() => assertBundleAllowlist([bad]), /bundle_include entry/, bad)
  }
})
