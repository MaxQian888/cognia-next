// `node --test scripts/build/stage-bundled-plugins.test.mjs`
//
// The staging step is the only thing standing between a curated plugin and an
// installer that does not contain it, so its two failure modes both need to be
// loud: shipping development residue (a machine-local virtualenv, a test tree)
// and shipping a plugin whose own code was renamed out from under an include
// pattern.

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  CATALOG_FILE,
  expandInclude,
  readDistribution,
  stageBundledPlugins,
} from "./stage-bundled-plugins.mjs"

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-stage-"))
}

test("the checked-in distribution lists repowiki as bundled", () => {
  const { bundled, devOnly } = readDistribution()
  assert.equal(bundled.repowiki.id, "cognia-repowiki")
  assert.ok(bundled.repowiki.include.includes("plugin.json"))
  // The demos stay out of the installer on purpose.
  assert.ok("cognia-python-demo" in devOnly)
  assert.ok("wasm-example-formatter" in devOnly)
})

test("staging copies the manifest and the package, and nothing else", () => {
  const out = tempDir()
  try {
    const { catalog } = stageBundledPlugins({ outDir: out, catalogFile: path.join(out, 'catalog.json') })
    const staged = fs
      .readdirSync(path.join(out, "repowiki"), { recursive: true })
      .map((entry) => String(entry).split(path.sep).join("/"))

    assert.ok(staged.includes("plugin.json"))
    assert.ok(staged.includes("main.py"))
    assert.ok(staged.includes("repowiki/core/analyzer.py"))

    for (const residue of [".venv", "__pycache__", ".pytest_cache", "tests", "uv.lock"]) {
      assert.ok(
        !staged.some((entry) => entry.split("/").includes(residue) || entry === residue),
        `${residue} must not ship`
      )
    }
    assert.ok(!staged.some((entry) => entry.endsWith(".test.ts")))

    const entry = catalog.entries.repowiki
    assert.equal(entry.id, "cognia-repowiki")
    assert.ok(entry.files.length > 20)
    for (const file of entry.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/u)
      // Not `> 0`: a package's `__init__.py` is legitimately empty.
      assert.equal(typeof file.bytes, "number")
      assert.ok(file.bytes >= 0)
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test("the catalog digests match the staged bytes", async () => {
  const out = tempDir()
  try {
    const { catalog } = stageBundledPlugins({ outDir: out, catalogFile: path.join(out, 'catalog.json') })
    const { createHash } = await import("node:crypto")
    for (const file of catalog.entries.repowiki.files) {
      const bytes = fs.readFileSync(path.join(out, "repowiki", file.path))
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256)
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test("an include that matches nothing is a build failure, not a silent skip", () => {
  const out = tempDir()
  const fake = {
    ...fs,
    readFileSync: (file, encoding) => {
      if (String(file).endsWith("distribution.json")) {
        return JSON.stringify({
          bundled: {
            repowiki: { id: "cognia-repowiki", reason: "x", include: ["plugin.json", "gone/**/*"] },
          },
          devOnly: {},
        })
      }
      return fs.readFileSync(file, encoding)
    },
  }
  try {
    assert.throws(() => stageBundledPlugins({ outDir: out, catalogFile: path.join(out, 'catalog.json'), fsImpl: fake }), /matched no files/u)
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test("expandInclude refuses a pattern shape it does not actually support", () => {
  assert.throws(() => expandInclude("/nowhere", "src/*.py"), /unsupported include pattern/u)
})

test("writes the catalog where the renderer imports it from", () => {
  const out = tempDir()
  try {
    const target = path.join(out, "catalog.json")
    const { catalogPath } = stageBundledPlugins({ outDir: out, catalogFile: target })
    assert.equal(catalogPath, target)
    assert.ok(fs.existsSync(target))
    // The default target is inside the app tree, not the resource tree: the
    // renderer imports it, so a read that the fs scope denies cannot silently
    // look like "nothing to seed".
    assert.match(CATALOG_FILE.split(path.sep).join("/"), /^lib\/plugin\/distribution\//u)
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})
