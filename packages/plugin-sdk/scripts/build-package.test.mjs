import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = readFileSync(resolve(packageRoot, "scripts/build-package.mjs"), "utf8")

test("uses the checked author declaration as the package declaration baseline", () => {
  assert.match(source, /types\/cognia-plugin-sdk\.d\.ts/)
  assert.match(source, /export \* from \"\.\/index\.js\"/)
})

test("the package test rebuilds declarations before packing", () => {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
  assert.match(manifest.scripts["pack:test"], /pnpm build/)
})
