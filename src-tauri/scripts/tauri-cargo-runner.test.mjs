/**
 * Regression coverage for the macOS Tauri cargo wrapper.
 *
 * Run with: node --test src-tauri/scripts/tauri-cargo-runner.test.mjs
 */

import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { afterEach, test } from "node:test"

const runner = fileURLToPath(new URL("./tauri-cargo-runner.sh", import.meta.url))
const macosConfig = fileURLToPath(new URL("../tauri.macos.conf.json", import.meta.url))
const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executable(path, source) {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

test("signs the successful debug artifact before returning to Tauri", () => {
  const dir = mkdtempSync(join(tmpdir(), "cognia-tauri-runner-"))
  tempDirs.push(dir)
  const targetDir = join(dir, "target")
  const cargoLog = join(dir, "cargo.log")
  const signLog = join(dir, "sign.log")
  const fakeCargo = join(dir, "cargo")
  const fakeSigner = join(dir, "signer")

  executable(
    fakeCargo,
    `#!/bin/sh
set -eu
printf '%s\n' "$@" > "$COGNIA_TEST_CARGO_LOG"
mkdir -p "$CARGO_TARGET_DIR/debug"
touch "$CARGO_TARGET_DIR/debug/cognia-next"
`
  )
  executable(
    fakeSigner,
    `#!/bin/sh
set -eu
printf '%s\n' "$@" > "$COGNIA_TEST_SIGN_LOG"
`
  )

  const result = spawnSync(runner, ["build", "--bin", "cognia-next"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: targetDir,
      COGNIA_CARGO_BIN: fakeCargo,
      COGNIA_DEV_CODESIGN_SCRIPT: fakeSigner,
      COGNIA_TEST_CARGO_LOG: cargoLog,
      COGNIA_TEST_SIGN_LOG: signLog,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(cargoLog, "utf8"), "build\n--bin\ncognia-next\n")
  assert.equal(
    readFileSync(signLog, "utf8"),
    `--sign-only\n${join(targetDir, "debug", "cognia-next")}\n`
  )
})

test("the macOS Tauri config builds through the signing runner", () => {
  const config = JSON.parse(readFileSync(macosConfig, "utf8"))
  assert.deepEqual(config.build?.runner, {
    cmd: "./scripts/tauri-cargo-runner.sh",
    cwd: ".",
  })
})
