import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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
    source: join("/repo", "target", "release", "cognia-server"),
    destination: join("/repo", "src-tauri", "binaries", "cognia-server-aarch64-apple-darwin"),
  })
  assert.deepEqual(sidecarPaths("C:/repo", "x86_64-pc-windows-msvc", "C:/target"), {
    source: join("C:/target", "release", "cognia-server.exe"),
    destination: join("C:/repo", "src-tauri", "binaries", "cognia-server-x86_64-pc-windows-msvc.exe"),
  })
})

test("Windows bundles the Cargo-discovered server once and retains external-only binaries", () => {
  const base = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  const windows = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"))
  const manifest = readFileSync(new URL("../../crates/cognia-server/Cargo.toml", import.meta.url), "utf8")
  assert.match(manifest, /\[\[bin\]\]\s+name = "cognia-server"/)
  assert.ok(base.bundle.externalBin.includes("binaries/cognia-server"))
  assert.deepEqual(
    windows.bundle.externalBin,
    base.bundle.externalBin.filter((binary) => binary !== "binaries/cognia-server")
  )
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
