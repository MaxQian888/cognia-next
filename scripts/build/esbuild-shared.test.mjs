import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"

import { cliEsbuildOptions, createCliEsbuildPlugins } from "./esbuild-shared.mjs"

const root = path.resolve(import.meta.dirname, "../..")

test("the option set is the shipped CLI configuration", () => {
  const options = cliEsbuildOptions({
    root,
    entry: "/x/entry.ts",
    outdir: "/x/out",
    entryNames: "cognia-agent",
  })
  assert.equal(options.format, "esm")
  assert.equal(options.platform, "node")
  assert.equal(options.splitting, true)
  assert.equal(options.packages, "external")
  assert.deepEqual(options.outExtension, { ".js": ".mjs" })
  assert.equal(options.banner.js, "#!/usr/bin/env node")
  assert.equal(options.tsconfig, path.join(root, "tsconfig.json"))
  assert.deepEqual(
    options.plugins.map((p) => p.name),
    createCliEsbuildPlugins(root).map((p) => p.name)
  )
})

test("the fixture variant drops the shebang and keeps every plugin", () => {
  const options = cliEsbuildOptions({
    root,
    entry: "/x/fixture.tsx",
    outdir: "/x/out",
    entryNames: "tui-app-fixture",
    banner: false,
  })
  assert.equal(options.banner, undefined)
  assert.equal(options.plugins.length, 4)
  assert.ok(options.plugins.some((p) => p.name === "stub-next-runtime"))
  assert.ok(options.plugins.some((p) => p.name === "json-default-only-messages"))
})
