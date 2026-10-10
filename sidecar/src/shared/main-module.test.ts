import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { isMainModule } from "./main-module.ts"

test("a launcher started through a symlinked directory is still the main module", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "main-module-")))
  try {
    mkdirSync(join(root, "real"))
    const script = join(root, "real", "entry.mjs")
    writeFileSync(script, "")
    symlinkSync(join(root, "real"), join(root, "linked"), "dir")
    // What Node reports for the module: the resolved path.
    const moduleUrl = pathToFileURL(script).href
    assert.equal(isMainModule(moduleUrl, script), true)
    assert.equal(isMainModule(moduleUrl, join(root, "linked", "entry.mjs")), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an imported module, a missing argv[1] or a vanished path is not the main module", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "main-module-")))
  try {
    const script = join(root, "entry.mjs")
    const other = join(root, "other.mjs")
    writeFileSync(script, "")
    writeFileSync(other, "")
    assert.equal(isMainModule(pathToFileURL(script).href, other), false)
    assert.equal(isMainModule(pathToFileURL(script).href, undefined), false)
    assert.equal(isMainModule(pathToFileURL(script).href, join(root, "gone.mjs")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
