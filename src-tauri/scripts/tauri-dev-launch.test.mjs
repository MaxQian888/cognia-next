/**
 * Regression coverage for the macOS Tauri development launch chain.
 *
 * Run with: node --test src-tauri/scripts/tauri-dev-launch.test.mjs
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const macosConfig = fileURLToPath(new URL("../tauri.macos.conf.json", import.meta.url))
const tauriConfig = fileURLToPath(new URL("../tauri.conf.json", import.meta.url))
const cargoConfig = fileURLToPath(new URL("../../.cargo/config.toml", import.meta.url))
const packageJson = fileURLToPath(new URL("../../package.json", import.meta.url))

test("Tauri owns the Cargo process directly during development", () => {
  const config = JSON.parse(readFileSync(macosConfig, "utf8"))

  assert.equal(
    config.build?.runner,
    undefined,
    "a wrapper process can be killed before its Cargo child and orphan the running app"
  )
})

test("Cargo still signs and replaces itself with the development app", () => {
  const config = readFileSync(cargoConfig, "utf8")

  assert.match(config, /\[target\.aarch64-apple-darwin\]/)
  assert.match(config, /exec "\$s" "\$@"/)
})

test("Tauri prepares the durable terminal host before starting development", () => {
  const tauri = JSON.parse(readFileSync(tauriConfig, "utf8"))
  const pkg = JSON.parse(readFileSync(packageJson, "utf8"))

  assert.match(tauri.build.beforeDevCommand, /terminal-host:prepare:dev/)
  assert.match(pkg.scripts["terminal-host:prepare:dev"], /cognia-server/)
})
