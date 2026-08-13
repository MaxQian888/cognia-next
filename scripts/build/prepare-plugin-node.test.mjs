import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  PLUGIN_NODE_VERSION,
  archiveFor,
  parseArgs,
  verifyArchive,
} from "./prepare-plugin-node.mjs"

test("parseArgs supports verification and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("archiveFor pins every supported desktop target", () => {
  assert.match(archiveFor("darwin", "arm64").file, new RegExp(`v${PLUGIN_NODE_VERSION}`))
  assert.match(archiveFor("darwin", "x64").file, /darwin-x64\.tar\.xz$/)
  assert.match(archiveFor("linux", "arm64").file, /linux-arm64\.tar\.xz$/)
  assert.match(archiveFor("linux", "x64").file, /linux-x64\.tar\.xz$/)
  assert.match(archiveFor("win32", "arm64").file, /win-arm64\.zip$/)
  assert.match(archiveFor("win32", "x64").file, /win-x64\.zip$/)
  assert.throws(() => archiveFor("freebsd", "x64"), /Unsupported/)
})

test("verifyArchive rejects bytes that do not match the pinned digest", () => {
  assert.doesNotThrow(() =>
    verifyArchive(Buffer.from("verified"), "1c34f88707b55e6104c4eb20e71ffa3d33e414b71ef689a15fad0640d0ac58cb")
  )
  assert.throws(() => verifyArchive(Buffer.from("tampered"), "0".repeat(64)), /checksum mismatch/)
})

test("Tauri build and dev commands bundle the verified runtime and Agent host", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"))

  assert.match(config.build.beforeBuildCommand, /plugin-node:prepare/)
  assert.match(config.build.beforeDevCommand, /plugin-node:prepare/)
  assert.ok(config.bundle.resources.includes("resources/plugin-node/**/*"))
  assert.ok(config.bundle.resources.includes("../sidecar/agent-host.mjs"))
})
