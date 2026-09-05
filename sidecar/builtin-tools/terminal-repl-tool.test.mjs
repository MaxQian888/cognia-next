import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { prepareNodePtyHelper } from "./terminal-repl-tool.mjs"

test("restores packaged PTY helper execute permission without changing other bits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-helper-"))
  try {
    const directory = path.join(root, "prebuilds/darwin-arm64")
    fs.mkdirSync(directory, { recursive: true })
    const helper = path.join(directory, "spawn-helper")
    fs.writeFileSync(helper, "helper", { mode: 0o640 })
    prepareNodePtyHelper(root, "darwin", "arm64")
    assert.equal(fs.statSync(helper).mode & 0o777, 0o751)
    prepareNodePtyHelper(root, "darwin", "arm64")
    assert.equal(fs.statSync(helper).mode & 0o777, 0o751)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("missing optional helpers and Windows need no permission mutation", () => {
  assert.doesNotThrow(() => prepareNodePtyHelper("/nonexistent/node-pty", "darwin", "arm64"))
  assert.doesNotThrow(() => prepareNodePtyHelper("/nonexistent/node-pty", "win32", "x64"))
})

test("read-only installations expose a repair instruction", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-helper-readonly-"))
  try {
    const directory = path.join(root, "build/Release")
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, "spawn-helper"), "helper", { mode: 0o644 })
    t.mock.method(fs, "chmodSync", () => {
      throw new Error("EROFS")
    })
    assert.throws(
      () => prepareNodePtyHelper(root, "darwin", "arm64"),
      /PTY helper is not executable:.*Reinstall node-pty.*EROFS/
    )
  } finally {
    t.mock.restoreAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
