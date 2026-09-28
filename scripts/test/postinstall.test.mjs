import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { repairNodePtySpawnHelper } from "../postinstall.mjs"

test("macOS PTY helpers are executable after installation without changing other mode bits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-pty-install-"))
  try {
    for (const relative of ["prebuilds/darwin-arm64/spawn-helper", "build/Release/spawn-helper"]) {
      const helper = path.join(root, relative)
      fs.mkdirSync(path.dirname(helper), { recursive: true })
      fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o640 })
    }
    repairNodePtySpawnHelper(root, "darwin", "arm64")
    for (const relative of ["prebuilds/darwin-arm64/spawn-helper", "build/Release/spawn-helper"]) {
      const helper = path.join(root, relative)
      assert.equal(fs.statSync(helper).mode & 0o777, 0o740)
      fs.accessSync(helper, fs.constants.X_OK)
    }
    repairNodePtySpawnHelper(root, "darwin", "arm64")
    assert.equal(fs.statSync(path.join(root, "build/Release/spawn-helper")).mode & 0o777, 0o740)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("other platforms and absent optional helpers are left alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-pty-install-"))
  try {
    const helper = path.join(root, "build/Release/spawn-helper")
    fs.mkdirSync(path.dirname(helper), { recursive: true })
    fs.writeFileSync(helper, "fixture", { mode: 0o640 })
    repairNodePtySpawnHelper(root, "linux", "arm64")
    assert.equal(fs.statSync(helper).mode & 0o777, 0o640)
    repairNodePtySpawnHelper(path.join(root, "missing"), "darwin", "arm64")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
