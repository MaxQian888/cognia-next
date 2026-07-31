import assert from "node:assert/strict"
import { test } from "node:test"

import {
  cargoBuildEnvironment,
  parseRustHost,
  sidecarPaths,
} from "./build-terminal-host-sidecar.mjs"

test("parseRustHost extracts the canonical rust target", () => {
  assert.equal(
    parseRustHost("rustc 1.93.0\nbinary: rustc\nhost: aarch64-apple-darwin\n"),
    "aarch64-apple-darwin"
  )
  assert.throws(() => parseRustHost("rustc 1.93.0"), /host target triple/)
})

test("sidecarPaths follows Tauri's target-suffixed external binary contract", () => {
  assert.deepEqual(sidecarPaths("/repo", "aarch64-apple-darwin"), {
    source: "/repo/target/release/cognia-server",
    destination: "/repo/src-tauri/binaries/cognia-server-aarch64-apple-darwin",
  })
  assert.deepEqual(sidecarPaths("C:/repo", "x86_64-pc-windows-msvc", "C:/target"), {
    source: "C:/target/release/cognia-server.exe",
    destination: "C:/repo/src-tauri/binaries/cognia-server-x86_64-pc-windows-msvc.exe",
  })
})

test("cargoBuildEnvironment breaks the sidecar externalBin build cycle", () => {
  const env = cargoBuildEnvironment({
    KEEP_ME: "yes",
    TAURI_CONFIG: JSON.stringify({ productName: "Cognia", bundle: { active: true } }),
  })
  assert.equal(env.KEEP_ME, "yes")
  assert.deepEqual(JSON.parse(env.TAURI_CONFIG), {
    productName: "Cognia",
    bundle: { active: true, externalBin: [] },
  })
})
