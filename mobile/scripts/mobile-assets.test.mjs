import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { isExcludedMobileAsset, pruneMobileAssets } from "./mobile-assets.mjs"
import { sourceFingerprint, stampArtifact, verifyArtifact } from "./android-artifact.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))

async function put(directory, relative, contents = "fixture") {
  const file = path.join(directory, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents)
}

test("only explicit authoring paths and unused alternate formats are excluded", () => {
  for (const relative of [
    "icons/cognia-mobile-spots/raw/expansion/templates.png",
    "icons/cognia-mobile-spots/qa/index.html",
    "icons/cognia-mobile-spots/png/templates.png",
    "icons/cognia-agent-team/raw/concept-sheet.png",
    "icons/cognia-agent-team/qa/contact-sheet-magenta.png",
    "icons/cognia-agent-team/png/coder.png",
    "icons/cognia-agent-team/contact-sheet-transparent.png",
    "sw.js",
    "sw.js.map",
  ])
    assert.equal(isExcludedMobileAsset(relative), true, relative)
  for (const relative of [
    "icons/cognia-mobile-spots/png/chat.png",
    "icons/cognia-mobile-spots/webp/templates.webp",
    "icons/cognia-agent-team/webp/coder.webp",
    "icons/cognia-mobile-spots/icon-manifest.json",
    "icons/cognia-mobile-spots/style-spec.json",
    "icons/cognia-agent-team/contact-sheet-transparent.png.backup",
    "icons/cognia-agent-team/raw-future/icon.png",
    "marketing/cognia-posters/01-multi-agent-orchestration.png",
    "plugins/cognia-material-icon-theme/icons/qa.svg",
    "plugins/__next._tree.txt",
    "monaco/vs/editor.js",
    "plugins/custom-sw.js",
    "sw.js.backup",
  ])
    assert.equal(isExcludedMobileAsset(relative), false, relative)
  for (const relative of ["", "/icons/file", "../file", "a/../file", "a\\file", "a//file"])
    assert.throws(() => isExcludedMobileAsset(relative), /Invalid/)
})

test("every current mobile icon and agent avatar runtime asset remains available", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "public/icons/cognia-mobile-spots/icon-manifest.json"), "utf8")
  )
  assert.equal(manifest.icons.length, 81)
  assert.equal(new Set(manifest.runtimeFormats.webp).size, 65)
  for (const { name } of manifest.icons) {
    const format = manifest.runtimeFormats.webp.includes(name)
      ? "webp"
      : manifest.runtimeFormats.default
    const relative = `icons/cognia-mobile-spots/${format}/${name}.${format}`
    assert.equal(isExcludedMobileAsset(relative), false, relative)
    assert.ok((await stat(path.join(root, "public", relative))).isFile(), relative)
    assert.equal(
      isExcludedMobileAsset(`icons/cognia-mobile-spots/png/${name}.png`),
      format === "webp"
    )
  }
  const cases = [
    ["lib/agent-team/avatar.ts", "AGENT_TEAM_AVATAR_IDS", "icons/cognia-agent-team/webp", "webp"],
  ]
  for (const [sourceFile, constant, prefix, extension] of cases) {
    const source = await readFile(path.join(root, sourceFile), "utf8")
    const list = source.match(new RegExp(`export const ${constant} = \\[([\\s\\S]*?)\\] as const`))
    assert.ok(list, `runtime inventory ${constant}`)
    assert.ok(source.includes(`/${prefix}/`), "review policy if runtime format changes")
    const names = [...list[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1])
    assert.ok(names.length > 0)
    for (const name of names) {
      const relative = `${prefix}/${name}.${extension}`
      assert.equal(isExcludedMobileAsset(relative), false)
      assert.ok((await stat(path.join(root, "public", relative))).isFile(), relative)
    }
    for (const name of await readdir(path.join(root, "public", prefix)))
      assert.equal(isExcludedMobileAsset(`${prefix}/${name}`), false)
  }
})

test("pruning is idempotent and the filtered export passes artifact integrity verification", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cognia-mobile-assets-"))
  try {
    await put(directory, "index.html", '<img src="/icons/cognia-mobile-spots/png/chat.png">')
    await put(directory, "icons/cognia-mobile-spots/png/chat.png")
    await put(directory, "icons/cognia-agent-team/webp/coder.webp")
    await put(directory, "icons/cognia-mobile-spots/raw/concept.png", "large raw")
    await put(directory, "icons/cognia-mobile-spots/png/templates.png", "alternate")
    await put(directory, "icons/cognia-mobile-spots/webp/templates.webp", "preferred")
    await put(
      directory,
      "icons/cognia-mobile-spots/icon-manifest.json",
      '{"source":"raw/concept.png"}'
    )
    await put(directory, "plugins/__next._tree.txt", "route")
    await put(directory, "sw.js", 'precache("/icons/cognia-mobile-spots/png/templates.png")')
    assert.deepEqual(await pruneMobileAssets(directory), {
      removedFiles: 3,
      removedBytes:
        18 + Buffer.byteLength('precache("/icons/cognia-mobile-spots/png/templates.png")'),
    })
    assert.deepEqual(await pruneMobileAssets(directory), { removedFiles: 0, removedBytes: 0 })
    assert.equal(await readFile(path.join(directory, "plugins/__next._tree.txt"), "utf8"), "route")
    const artifact = await stampArtifact(directory, "inputs")
    assert.equal(Object.keys(artifact.files).length, 6)
    await verifyArtifact(directory, "inputs")
    await assert.rejects(pruneMobileAssets(directory), /stamped/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a missing WebP replacement refuses pruning without deleting its PNG", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cognia-mobile-missing-webp-"))
  try {
    await put(directory, "index.html", "page")
    await put(directory, "icons/cognia-mobile-spots/png/templates.png", "original")
    await assert.rejects(pruneMobileAssets(directory), /missing replacement asset.*templates.webp/)
    assert.equal(
      await readFile(path.join(directory, "icons/cognia-mobile-spots/png/templates.png"), "utf8"),
      "original"
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("all 81 selected runtime paths survive pruning while only 65 redundant PNGs disappear", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cognia-mobile-icon-inventory-"))
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, "public/icons/cognia-mobile-spots/icon-manifest.json"), "utf8")
    )
    const selected = []
    for (const { name } of manifest.icons) {
      await put(directory, `icons/cognia-mobile-spots/png/${name}.png`)
      const format = manifest.runtimeFormats.webp.includes(name) ? "webp" : "png"
      if (format === "webp") await put(directory, `icons/cognia-mobile-spots/webp/${name}.webp`)
      selected.push(`icons/cognia-mobile-spots/${format}/${name}.${format}`)
    }
    await put(directory, "index.html", selected.map((file) => `<img src="/${file}">`).join(""))
    const result = await pruneMobileAssets(directory)
    assert.equal(result.removedFiles, 65)
    assert.equal(selected.length, 81)
    for (const relative of selected)
      assert.equal(await readFile(path.join(directory, relative), "utf8"), "fixture")
    await stampArtifact(directory, "inputs")
    await verifyArtifact(directory, "inputs")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

for (const [file, source] of [
  ["index.html", '<img src="/icons/cognia-mobile-spots/png/templates.png">'],
  ["_next/static/chunks/app.js", 'const base = "/icons/cognia-mobile-spots/png/"'],
  ["index.txt", '"icons\\/cognia-mobile-spots\\/png\\/templates.png"'],
  ["runtime.json", '{"image":"/icons/cognia-mobile-spots/png/templates.png"}'],
  ["_next/static/sw-registration.js", 'navigator.serviceWorker.register("/sw.js")'],
]) {
  test(`runtime references in ${file} refuse pruning before deleting any asset`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cognia-mobile-reference-"))
    try {
      await put(directory, "index.html", "page")
      await put(directory, "icons/cognia-mobile-spots/png/templates.png", "keep on failure")
      await put(directory, "icons/cognia-mobile-spots/webp/templates.webp", "preferred")
      await put(directory, file, source)
      await assert.rejects(pruneMobileAssets(directory), /runtime asset reference/)
      assert.equal(
        await readFile(path.join(directory, "icons/cognia-mobile-spots/png/templates.png"), "utf8"),
        "keep on failure"
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("missing export and symlink paths fail without changing source files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cognia-mobile-symlink-"))
  try {
    const source = path.join(directory, "public")
    const output = path.join(directory, "out")
    await mkdir(source)
    await mkdir(output)
    await assert.rejects(pruneMobileAssets(output), /missing index/)
    await put(output, "index.html")
    await put(source, "keep.png", "source")
    await symlink(source, path.join(output, "icons"), "dir")
    await assert.rejects(pruneMobileAssets(output), /symlink/)
    assert.equal(await readFile(path.join(source, "keep.png"), "utf8"), "source")
    await symlink(output, path.join(directory, "linked"), "dir")
    await assert.rejects(pruneMobileAssets(path.join(directory, "linked")), /real directory/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("source fingerprints retain authoring inputs referenced by generation manifests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cognia-mobile-input-policy-"))
  try {
    const relative = "public/icons/cognia-mobile-spots/raw/concept.png"
    await put(directory, relative, "first")
    const run = async () => `${relative}\0`
    const before = await sourceFingerprint(directory, run, {})
    await put(directory, relative, "changed")
    assert.notEqual(await sourceFingerprint(directory, run, {}), before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Monaco generation marker is excluded while its runtime stays packaged", () => {
  assert.equal(isExcludedMobileAsset("monaco/vs/.monaco-version"), true)
  assert.equal(isExcludedMobileAsset("monaco/vs/loader.js"), false)
})
