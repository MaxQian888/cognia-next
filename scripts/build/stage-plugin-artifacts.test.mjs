// `node --test scripts/build/stage-plugin-artifacts.test.mjs`
//
// The consumer is the only way plugin output reaches the host build, so it is
// tested against hand-made sets in a host root that has no `plugins/` at all.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  PLUGIN_ARTIFACT_MANIFEST,
  PLUGIN_ARTIFACT_SECTIONS,
} from "./plugin-artifact-format.mjs"
import {
  LOCAL_ARTIFACT_DIR,
  PLUGIN_ARTIFACTS_ENV,
  WEB_SECTIONS,
  readPluginArtifactSet,
  resolvePluginArtifactSet,
  stagePluginArtifacts,
} from "./stage-plugin-artifacts.mjs"

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const SET_FILES = {
  "builtin-plugins/alpha/abc.cjs": "module.exports = 1",
  "builtin-plugins/alpha/resources/plugin.json": '{"id":"alpha"}',
  "builtin-plugins/_shared/pdf.worker.x.mjs": "worker",
  "plugin-icons/alpha/assets/icon.png": "png",
  "desktop-plugins/beta/plugin.json": '{"id":"beta"}',
  "desktop-plugins/beta/main.py": "print('beta')",
  "browser-builtin-assets.json": '{"version":1,"entries":{}}\n',
  "builtin-preboot-manifests.json": '{"version":1,"plugins":{}}\n',
  "bundled-plugins.json": '{"entries":{}}\n',
}

/** Write a set and its manifest; `files` overrides or (with `null`) removes entries. */
function writeSet(dir, files = {}, { manifestFiles } = {}) {
  const contents = { ...SET_FILES, ...files }
  const listed = {}
  for (const [relative, text] of Object.entries(contents)) {
    if (text === null) continue
    const file = path.join(dir, ...relative.split("/"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    listed[relative] = createHash("sha256").update(text).digest("hex")
  }
  fs.writeFileSync(
    path.join(dir, PLUGIN_ARTIFACT_MANIFEST),
    JSON.stringify({ schema: 1, files: manifestFiles ?? listed })
  )
  return dir
}

function host(root, relative) {
  return path.join(root, ...relative.split("/"))
}

function noProduce() {
  throw new Error("must not produce")
}

test("stages every section of an external set into the host tree without plugins/", async (t) => {
  const root = tempDir(t, "host-")
  const set = writeSet(tempDir(t, "set-"))
  const result = await stagePluginArtifacts({ root, from: set, env: {}, produce: noProduce })
  assert.equal(result.source, "external")
  assert.deepEqual(result.changed.sort(), Object.keys(PLUGIN_ARTIFACT_SECTIONS).sort())
  assert.equal(
    fs.readFileSync(host(root, "public/_cognia/builtin-plugins/alpha/abc.cjs"), "utf8"),
    "module.exports = 1"
  )
  assert.equal(
    fs.readFileSync(host(root, "public/_cognia/plugin-icons/alpha/assets/icon.png"), "utf8"),
    "png"
  )
  assert.equal(
    fs.readFileSync(host(root, "src-tauri/resources/plugins/beta/main.py"), "utf8"),
    "print('beta')"
  )
  for (const name of ["builtinIndex", "prebootManifests", "desktopCatalog"]) {
    const section = PLUGIN_ARTIFACT_SECTIONS[name]
    assert.equal(
      fs.readFileSync(host(root, section.host), "utf8"),
      SET_FILES[section.set]
    )
  }
  assert.equal(fs.existsSync(path.join(root, "plugins")), false)
})

test("reads the set named by the environment variable", async (t) => {
  const root = tempDir(t, "host-")
  const set = writeSet(tempDir(t, "set-"))
  const resolved = await resolvePluginArtifactSet({
    root,
    env: { [PLUGIN_ARTIFACTS_ENV]: set },
    produce: noProduce,
  })
  assert.deepEqual(resolved, { dir: set, source: "external" })
})

test("an explicit set wins over plugin sources in the checkout", async (t) => {
  const root = tempDir(t, "host-")
  fs.mkdirSync(path.join(root, "plugins"))
  const set = writeSet(tempDir(t, "set-"))
  const resolved = await resolvePluginArtifactSet({ root, from: set, env: {}, produce: noProduce })
  assert.equal(resolved.source, "external")
})

test("produces into the local cache when only plugin sources are present", async (t) => {
  const root = tempDir(t, "host-")
  fs.mkdirSync(path.join(root, "plugins"))
  const calls = []
  const resolved = await resolvePluginArtifactSet({
    root,
    env: {},
    produce: async (options) => {
      calls.push(options)
      writeSet(options.outDir)
    },
  })
  assert.deepEqual(calls, [
    {
      root,
      pluginsRoot: path.join(root, "plugins"),
      outDir: path.join(root, LOCAL_ARTIFACT_DIR),
    },
  ])
  assert.deepEqual(resolved, { dir: path.join(root, LOCAL_ARTIFACT_DIR), source: "produced" })
})

test("with neither a set nor plugin sources, the build stops and says how to fix it", async (t) => {
  const root = tempDir(t, "host-")
  await assert.rejects(
    stagePluginArtifacts({ root, env: {}, produce: noProduce }),
    (error) =>
      error.message.includes(PLUGIN_ARTIFACTS_ENV) && error.message.includes("produce.mjs")
  )
})

test("a set that fails verification changes nothing in the host tree", async (t) => {
  const cases = {
    "digest mismatch": (dir) => {
      writeSet(dir)
      fs.writeFileSync(path.join(dir, "builtin-plugins/alpha/abc.cjs"), "tampered")
    },
    "missing file": (dir) => {
      writeSet(dir)
      fs.rmSync(path.join(dir, "plugin-icons/alpha/assets/icon.png"))
    },
    "unlisted file": (dir) => {
      writeSet(dir)
      fs.writeFileSync(path.join(dir, "builtin-plugins/alpha/extra.cjs"), "extra")
    },
    "path outside every section": (dir) => writeSet(dir, { "elsewhere/file.txt": "x" }),
    "traversal": (dir) =>
      writeSet(dir, {}, { manifestFiles: { "builtin-plugins/../escape.txt": "0".repeat(64) } }),
    "missing catalog": (dir) => writeSet(dir, { "bundled-plugins.json": null }),
    "wrong schema": (dir) => {
      writeSet(dir)
      const manifestPath = path.join(dir, PLUGIN_ARTIFACT_MANIFEST)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, schema: 2 }))
    },
    "no manifest": (dir) => {
      writeSet(dir)
      fs.rmSync(path.join(dir, PLUGIN_ARTIFACT_MANIFEST))
    },
  }
  for (const [label, make] of Object.entries(cases)) {
    const root = tempDir(t, "host-")
    const set = tempDir(t, "set-")
    make(set)
    await assert.rejects(
      stagePluginArtifacts({ root, from: set, env: {}, produce: noProduce }),
      Error,
      label
    )
    assert.deepEqual(fs.readdirSync(root), [], label)
  }
})

test("trees are mirrored, and an unchanged set rewrites nothing", async (t) => {
  const root = tempDir(t, "host-")
  const stale = host(root, "public/_cognia/builtin-plugins/old/gone.cjs")
  fs.mkdirSync(path.dirname(stale), { recursive: true })
  fs.writeFileSync(stale, "stale")
  const set = writeSet(tempDir(t, "set-"))
  await stagePluginArtifacts({ root, from: set, env: {} })
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(path.dirname(stale)), false)

  const watched = [
    host(root, "public/_cognia/builtin-plugins/alpha/abc.cjs"),
    host(root, "src-tauri/resources/plugins/beta/main.py"),
    host(root, PLUGIN_ARTIFACT_SECTIONS.builtinIndex.host),
  ]
  const past = new Date("2020-01-01T00:00:00Z")
  for (const file of watched) fs.utimesSync(file, past, past)
  const again = await stagePluginArtifacts({ root, from: set, env: {} })
  assert.deepEqual(again.changed, [])
  for (const file of watched) assert.equal(fs.statSync(file).mtimeMs, past.getTime())
})

test("a changed desktop section replaces the whole staged tree", async (t) => {
  const root = tempDir(t, "host-")
  await stagePluginArtifacts({ root, from: writeSet(tempDir(t, "set-")), env: {} })
  const next = writeSet(tempDir(t, "set-"), {
    "desktop-plugins/beta/main.py": null,
    "desktop-plugins/gamma/plugin.json": '{"id":"gamma"}',
  })
  const result = await stagePluginArtifacts({ root, from: next, env: {} })
  assert.ok(result.changed.includes("desktopPlugins"))
  assert.deepEqual(fs.readdirSync(host(root, "src-tauri/resources/plugins")).sort(), [
    "beta",
    "gamma",
  ])
  assert.equal(fs.existsSync(host(root, "src-tauri/resources/plugins/beta/main.py")), false)
})

test("web-only staging leaves the installer section alone but still verifies it", async (t) => {
  assert.equal(WEB_SECTIONS.includes("desktopPlugins"), false)
  const root = tempDir(t, "host-")
  const set = writeSet(tempDir(t, "set-"))
  const result = await stagePluginArtifacts({ root, from: set, env: {}, sections: WEB_SECTIONS })
  assert.equal(result.changed.includes("desktopPlugins"), false)
  assert.equal(fs.existsSync(host(root, "src-tauri")), false)
  assert.ok(fs.existsSync(host(root, PLUGIN_ARTIFACT_SECTIONS.desktopCatalog.host)))

  fs.writeFileSync(path.join(set, "desktop-plugins/beta/main.py"), "tampered")
  await assert.rejects(
    stagePluginArtifacts({ root, from: set, env: {}, sections: WEB_SECTIONS }),
    /does not match/
  )
})

test("readPluginArtifactSet groups files by section", (t) => {
  const sections = readPluginArtifactSet(writeSet(tempDir(t, "set-")))
  assert.deepEqual([...sections.builtinChunks.keys()].sort(), [
    "_shared/pdf.worker.x.mjs",
    "alpha/abc.cjs",
    "alpha/resources/plugin.json",
  ])
  assert.deepEqual([...sections.desktopCatalog.keys()], [""])
})
