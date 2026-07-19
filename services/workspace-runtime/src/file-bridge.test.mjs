import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { WorkspaceFileBridge } from "./file-bridge.mjs"

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-runtime-"))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-outside-"))
  await fs.writeFile(path.join(root, "upload.txt"), "safe")
  await fs.writeFile(path.join(outside, "secret.txt"), "secret")
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })
  return { root }
}

test("resolves uploads inside the workspace and rejects traversal/symlink escape", async (t) => {
  const { root } = await fixture(t)
  const bridge = new WorkspaceFileBridge({ workspaceRoot: root })
  assert.deepEqual(await bridge.resolveUploads(["upload.txt"]), [
    await fs.realpath(path.join(root, "upload.txt")),
  ])
  await assert.rejects(() => bridge.resolveUploads(["../secret.txt"]), /outside workspace/)
  await assert.rejects(() => bridge.resolveUploads(["escape.txt"]), /outside workspace/)
})

test("enforces upload count and size quotas", async (t) => {
  const { root } = await fixture(t)
  const bridge = new WorkspaceFileBridge({
    workspaceRoot: root,
    maxUploadFiles: 1,
    maxUploadFileBytes: 3,
  })
  await assert.rejects(() => bridge.resolveUploads(["upload.txt", "upload.txt"]), /too many/)
  await assert.rejects(() => bridge.resolveUploads(["upload.txt"]), /too large/)
})

test("quarantines downloads until the user explicitly saves or deletes them", async (t) => {
  const { root } = await fixture(t)
  const bridge = new WorkspaceFileBridge({ workspaceRoot: root })
  const pending = await bridge.quarantineDownload("session-1", "report.txt", Buffer.from("ok"))
  assert.equal(pending.state, "quarantined")
  assert.equal(await fs.readFile(path.join(root, "report.txt")).catch(() => null), null)

  const saved = await bridge.saveDownload(pending.id, "report.txt")
  assert.equal(saved.state, "saved")
  assert.equal(await fs.readFile(path.join(root, "report.txt"), "utf8"), "ok")

  const disposable = await bridge.quarantineDownload("session-1", "delete.txt", Buffer.from("x"))
  await bridge.deleteDownload(disposable.id)
  assert.equal(bridge.listDownloads("session-1").length, 1)
})
