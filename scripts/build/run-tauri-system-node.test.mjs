import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { createSystemNodeOverride } from "./run-tauri-system-node.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"))
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))

test("system-node profile omits only the bundled Node runtime", () => {
  const override = createSystemNodeOverride(config)

  assert.deepEqual(override.bundle.resources, [
    ...config.bundle.resources.filter((resource) => resource !== "resources/plugin-node/**/*"),
  ])
  assert.ok(override.bundle.resources.includes("../sidecar/agent-host.mjs"))
  assert.ok(override.bundle.resources.includes("../sidecar/node_modules/**/*"))
})

test("system-node profile skips runtime preparation for build and dev", () => {
  const override = createSystemNodeOverride(config)

  assert.doesNotMatch(override.build.beforeBuildCommand, /plugin-node:prepare/)
  assert.doesNotMatch(override.build.beforeDevCommand, /plugin-node:prepare/)
  assert.match(override.build.beforeBuildCommand, /terminal-host:prepare/)
  assert.match(override.build.beforeDevCommand, /terminal-host:prepare:dev/)
})

test("system-node profile rejects a base config without the bundled runtime", () => {
  assert.throws(
    () =>
      createSystemNodeOverride({
        build: config.build,
        bundle: { ...config.bundle, resources: ["../sidecar/agent-host.mjs"] },
      }),
    /bundled Node resource/
  )
})

test("package scripts expose explicit bundled and system-node desktop profiles", () => {
  assert.equal(packageJson.scripts["tauri:build:bundled"], "tauri build")
  assert.equal(
    packageJson.scripts["tauri:build:system-node"],
    "node scripts/build/run-tauri-system-node.mjs build"
  )
  assert.equal(
    packageJson.scripts["tauri:dev:bundled"],
    "node scripts/dev/tauri.mjs dev"
  )
  assert.equal(
    packageJson.scripts["tauri:dev:system-node"],
    "node scripts/build/run-tauri-system-node.mjs dev"
  )
})
