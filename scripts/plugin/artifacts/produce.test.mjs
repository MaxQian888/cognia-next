// `node --test scripts/plugin/artifacts/produce.test.mjs`
//
// End to end over a tiny plugin tree: the producer's set must be exactly what
// the host consumer accepts.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { build } from "esbuild"

import { PLUGIN_ARTIFACT_MANIFEST } from "../../build/plugin-artifact-format.mjs"
import { readPluginArtifactSet, stagePluginArtifacts } from "../../build/stage-plugin-artifacts.mjs"
import { listSetFiles, producePluginArtifacts } from "./produce.mjs"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-artifacts-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (relative, text) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  const manifest = {
    id: "tiny",
    version: "1.0.0",
    type: "frontend",
    main: "src/index.ts",
    icon: "assets/icon.png",
  }
  write("lib/plugin/distribution/browser-builtins.json", JSON.stringify(["tiny"]))
  write(
    "lib/plugin/distribution/distribution.json",
    JSON.stringify({ bundled: { snake: { id: "snake", include: ["plugin.json", "main.py"] } } })
  )
  write("plugins/tiny/plugin.json", JSON.stringify(manifest))
  write("plugins/tiny/assets/icon.png", "icon")
  write(
    "plugins/tiny/src/index.ts",
    `export default { manifest: ${JSON.stringify(manifest)}, activate() {} }`
  )
  write(
    "plugins/snake/plugin.json",
    JSON.stringify({ id: "snake", version: "0.1.0", type: "python" })
  )
  write("plugins/snake/main.py", "print('snake')")
  write("plugins/snake/tests/test_main.py", "DO NOT SHIP")
  write("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "export const worker = 1")
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'")
  return { root, outDir: path.join(root, "out-set") }
}

test("the produced set lists every file with its digest and stages cleanly", async (t) => {
  const f = fixture(t)
  const { manifest } = await producePluginArtifacts({
    root: f.root,
    outDir: f.outDir,
    bundle: build,
  })
  const files = listSetFiles(f.outDir).filter((file) => file !== PLUGIN_ARTIFACT_MANIFEST)
  assert.deepEqual(Object.keys(manifest.files).sort(), files)
  for (const file of files) {
    const digest = createHash("sha256")
      .update(fs.readFileSync(path.join(f.outDir, file)))
      .digest("hex")
    assert.equal(manifest.files[file], digest, file)
  }
  assert.ok(files.includes("plugin-icons/tiny/assets/icon.png"))
  assert.ok(files.includes("desktop-plugins/snake/main.py"))
  assert.ok(!files.some((file) => file.includes("tests/")))
  assert.ok(files.some((file) => /^builtin-plugins\/tiny\/[0-9a-f]{64}\.cjs$/.test(file)))
  const index = JSON.parse(
    fs.readFileSync(path.join(f.outDir, "browser-builtin-assets.json"), "utf8")
  )
  assert.deepEqual(Object.keys(index.entries), ["tiny"])
  assert.match(index.entries.tiny.asset.url, /^\/_cognia\/builtin-plugins\/tiny\//)

  // The host consumer accepts exactly this set, without plugin sources.
  readPluginArtifactSet(f.outDir)
  const host = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-artifacts-host-"))
  t.after(() => fs.rmSync(host, { recursive: true, force: true }))
  await stagePluginArtifacts({ root: host, from: f.outDir, env: {} })
  assert.ok(fs.existsSync(path.join(host, "src-tauri/resources/plugins/snake/main.py")))
  assert.ok(fs.existsSync(path.join(host, "public", index.entries.tiny.asset.url)))
})

test("plugin sources can live outside the toolchain root", async (t) => {
  const f = fixture(t)
  const sources = path.join(f.root, "elsewhere")
  fs.renameSync(path.join(f.root, "plugins"), sources)
  const { manifest } = await producePluginArtifacts({
    root: f.root,
    pluginsRoot: sources,
    outDir: f.outDir,
    bundle: build,
  })
  assert.ok("desktop-plugins/snake/main.py" in manifest.files)
})

test("a failed production leaves no manifest, so the consumer refuses the set", async (t) => {
  const f = fixture(t)
  await producePluginArtifacts({ root: f.root, outDir: f.outDir, bundle: build })
  fs.rmSync(path.join(f.root, "plugins/snake/main.py"))
  await assert.rejects(
    producePluginArtifacts({ root: f.root, outDir: f.outDir, bundle: build }),
    /matched no files/
  )
  assert.equal(fs.existsSync(path.join(f.outDir, PLUGIN_ARTIFACT_MANIFEST)), false)
  assert.throws(() => readPluginArtifactSet(f.outDir), /has no plugin-artifacts\.json/)
})

test("a missing plugin source directory is an error, not an empty set", async (t) => {
  const f = fixture(t)
  await assert.rejects(
    producePluginArtifacts({
      root: f.root,
      pluginsRoot: path.join(f.root, "nope"),
      outDir: f.outDir,
    }),
    /does not exist/
  )
})
