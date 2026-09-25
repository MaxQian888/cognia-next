import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { BUN_SIDECAR_PATCHES, applySidecarPatch, patchFilter, replaceExactly } from "./bun-sidecar-patches.mjs"

const root = fileURLToPath(new URL("../../..", import.meta.url))

test("every patched sidecar module exists and every anchor matches exactly once", () => {
  // The compiled CLI build fails on a missed anchor; this fails the same drift
  // at test time, when a sidecar module is moved, renamed or retyped.
  for (const patch of BUN_SIDECAR_PATCHES) {
    const filePath = path.join(root, patch.file)
    assert.ok(fs.existsSync(filePath), `${patch.file} is patched by the Bun build but does not exist`)
    const source = fs.readFileSync(filePath, "utf8")
    const patched = applySidecarPatch(patch, source, { root, filePath })
    assert.notEqual(patched, source, `${patch.file} patch changed nothing`)
  }
})

test("the loader matches the patched module's language", () => {
  for (const patch of BUN_SIDECAR_PATCHES) {
    assert.equal(patch.loader, /\.(ts|mts)$/.test(patch.file) ? "ts" : "js", patch.file)
  }
})

test("the codegraph patch inlines the sibling schema and drops the file read", () => {
  const patch = BUN_SIDECAR_PATCHES.find((p) => p.file.endsWith("store-sqlite.mjs"))
  const filePath = path.join(root, patch.file)
  const patched = applySidecarPatch(patch, fs.readFileSync(filePath, "utf8"), { root, filePath })
  const schema = fs.readFileSync(path.join(path.dirname(filePath), "schema.sql"), "utf8")
  assert.ok(patched.includes(`const SCHEMA_SQL = ${JSON.stringify(schema)}`))
  assert.ok(!patched.includes('readFileSync(path.join(HERE, "schema.sql")'))
})

test("patchFilter matches the module under either path separator and nothing else", () => {
  const filter = patchFilter({ file: "sidecar/lsp/service-loader.mjs" })
  assert.ok(filter.test("/repo/sidecar/lsp/service-loader.mjs"))
  assert.ok(filter.test("C:\\repo\\sidecar\\lsp\\service-loader.mjs"))
  assert.ok(!filter.test("/repo/sidecar/lsp/service-loader.mjs.bak"))
  assert.ok(!filter.test("/repo/other/lsp/service-loader.mjs"))
})

test("replaceExactly refuses zero and multiple matches", () => {
  assert.equal(replaceExactly("a b c", "b", "B", "one"), "a B c")
  assert.throws(() => replaceExactly("a c", "b", "B", "none"), /none expected exactly one source match; found 0/)
  assert.throws(() => replaceExactly("b b", /b/, "B", "two"), /two expected exactly one source match; found 2/)
})
