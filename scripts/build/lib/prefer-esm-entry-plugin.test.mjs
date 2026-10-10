import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { createPreferEsmEntryPlugin, esmEntryOf } from "./prefer-esm-entry-plugin.mjs"

function setupPlugin(packages) {
  let registered
  createPreferEsmEntryPlugin({ packages }).setup({
    onResolve: (options, callback) => {
      registered = { options, callback }
    },
  })
  return registered
}

test("bare imports of a listed package resolve to its ESM entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prefer-esm-"))
  try {
    const dir = path.join(root, "node_modules", "jsonc-parser")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "jsonc-parser", main: "./lib/umd/main.js", module: "./lib/esm/main.js" })
    )
    assert.equal(esmEntryOf(dir), path.join(dir, "lib/esm/main.js"))

    const { options, callback } = setupPlugin(["jsonc-parser"])
    assert.ok(options.filter.test("jsonc-parser"))
    assert.ok(!options.filter.test("jsonc-parser/lib/umd/main.js"))
    assert.ok(!options.filter.test("not-jsonc-parser"))
    const resolved = callback({ path: "jsonc-parser", resolveDir: path.join(root, "src") })
    assert.equal(resolved.path, path.join(fs.realpathSync(dir), "lib/esm/main.js"))
    // Not installed where the importer sits: leave it to esbuild's own resolver.
    assert.equal(callback({ path: "jsonc-parser", resolveDir: os.tmpdir() }), undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a listed package without an ESM entry is a build error, not a silent UMD bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prefer-esm-"))
  try {
    const dir = path.join(root, "node_modules", "umd-only")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "umd-only", main: "./umd.js" }))
    const { callback } = setupPlugin(["umd-only"])
    const result = callback({ path: "umd-only", resolveDir: root })
    assert.match(result.errors[0].text, /declares no "module" entry/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
