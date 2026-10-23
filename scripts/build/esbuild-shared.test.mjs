import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import fs from "node:fs"

import {
  cliEsbuildOptions,
  createCliEsbuildPlugins,
  undeclaredCliRuntimeDependencies,
} from "./esbuild-shared.mjs"

const root = path.resolve(import.meta.dirname, "../..")

test("shipped CLI declares the legacy and current OpenCode SDK runtime imports", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "cli/package.json"), "utf8"))
  const metafile = { outputs: { "cli.mjs": { imports: [
    { path: "@opencode-ai/sdk/client", external: true },
    { path: "@opencode/client", external: true },
  ] } } }
  assert.deepEqual(undeclaredCliRuntimeDependencies(metafile, manifest), [])
})

test("CLI runtime checks require an own declaration for prototype-named packages", () => {
  const metafile = {
    outputs: { "cli.mjs": { imports: [{ path: "constructor", external: true }] } },
  }
  assert.deepEqual(undeclaredCliRuntimeDependencies(metafile, {}), ["constructor"])
  assert.deepEqual(
    undeclaredCliRuntimeDependencies(metafile, { dependencies: { constructor: "1.0.0" } }),
    []
  )
})

test("CLI runtime checks reject external packages supplied only by the build environment", () => {
  const metafile = { outputs: { "cli.mjs": { imports: [
    { path: "fake-indexeddb/auto", external: true },
    { path: "@scope/client/http", external: true },
    { path: "@scope/client", external: true },
    { path: "chalk", external: true },
    { path: "node:fs", external: true },
    { path: "fs/promises", external: true },
    { path: "./chunks/local.mjs", external: false },
  ] } } }
  assert.deepEqual(undeclaredCliRuntimeDependencies(metafile, {
    dependencies: { chalk: "6.0.1" },
    devDependencies: { "fake-indexeddb": "6.2.6", "@scope/client": "1.0.0" },
  }), ["@scope/client", "fake-indexeddb"])
})

test("CLI runtime checks accept production, peer and optional package contracts", () => {
  const metafile = { outputs: { "cli.mjs": { imports: [
    { path: "fake-indexeddb/auto", external: true },
    { path: "react/jsx-runtime", external: true },
    { path: "node-pty", external: true },
  ] } } }
  assert.deepEqual(undeclaredCliRuntimeDependencies(metafile, {
    dependencies: { "fake-indexeddb": "6.2.6" },
    peerDependencies: { react: "^19.0.0" },
    optionalDependencies: { "node-pty": "1.1.0" },
  }), [])
})

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
  assert.equal(options.plugins.length, 3)
  assert.ok(options.plugins.some((p) => p.name === "stub-next-runtime"))
  assert.ok(options.plugins.some((p) => p.name === "json-default-only-messages"))
})
