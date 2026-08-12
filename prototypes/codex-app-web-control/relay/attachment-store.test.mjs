import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import test from "node:test"

import { createAttachmentStore } from "./attachment-store.mjs"

test("attachment store streams private files and never exposes local paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cognia-attachment-test-"))
  const store = createAttachmentStore({ root, maxFileBytes: 32, maxTotalBytes: 64 })
  t.after(() => store.cleanup())

  const uploaded = await store.upload(Readable.from(["hello", " world"]), {
    name: encodeURIComponent("proof file.txt"),
    mimeType: "text/plain",
    contentLength: 11,
  })

  assert.equal(uploaded.name, "proof file.txt")
  assert.equal(uploaded.size, 11)
  assert.equal("path" in uploaded, false)
  const [resolved] = store.resolveIds([uploaded.id])
  assert.equal(await readFile(resolved.path, "utf8"), "hello world")
  assert.equal(store.list()[0].sha256.length, 64)
})

test("attachment store rejects traversal, missing ids, and oversized streams", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cognia-attachment-test-"))
  const store = createAttachmentStore({ root, maxFileBytes: 4, maxTotalBytes: 8 })
  t.after(() => store.cleanup())

  const uploaded = await store.upload(Readable.from(["safe"]), { name: "../safe.txt" })
  assert.equal(uploaded.name, "safe.txt")
  assert.throws(() => store.resolveIds(["missing"]), /attachment not found/)
  await assert.rejects(
    store.upload(Readable.from(["12345"]), { name: "large.txt" }),
    /attachment exceeds 4 bytes/
  )
  assert.equal(store.list().length, 1)
})

test("attachment store reconstructs folders without allowing relative traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cognia-attachment-test-"))
  const store = createAttachmentStore({ root, maxFileBytes: 32, maxTotalBytes: 64 })
  t.after(() => store.cleanup())

  const folder = await store.createFolder({ name: "evidence" })
  const updated = await store.uploadFolderFile(folder.id, Readable.from(["nested proof"]), {
    relativePath: encodeURIComponent("evidence/nested/proof.txt"),
    contentLength: 12,
  })

  assert.equal(updated.kind, "folder")
  assert.equal(updated.fileCount, 1)
  const [resolved] = store.resolveIds([folder.id])
  assert.equal(await readFile(join(resolved.path, "nested", "proof.txt"), "utf8"), "nested proof")
  await assert.rejects(
    store.uploadFolderFile(folder.id, Readable.from(["bad"]), {
      relativePath: encodeURIComponent("evidence/../escape.txt"),
    }),
    /relative path is invalid/
  )
})

test("attachment store imports one local directory as one private folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cognia-attachment-test-"))
  const source = await mkdtemp(join(tmpdir(), "cognia-directory-source-"))
  await mkdir(join(source, "nested"))
  await mkdir(join(source, "empty"))
  await writeFile(join(source, "root.txt"), "root")
  await writeFile(join(source, "percent%20.txt"), "percent")
  await writeFile(join(source, "nested", "proof.txt"), "proof")
  const store = createAttachmentStore({ root, maxFileBytes: 32, maxTotalBytes: 64 })
  t.after(() => Promise.all([store.cleanup(), rm(source, { recursive: true, force: true })]))

  const imported = await store.importFolder(source)

  assert.equal(imported.kind, "folder")
  assert.equal(imported.fileCount, 3)
  assert.equal(store.list().length, 1)
  const [resolved] = store.resolveIds([imported.id])
  assert.equal(await readFile(join(resolved.path, "root.txt"), "utf8"), "root")
  assert.equal(await readFile(join(resolved.path, "percent%20.txt"), "utf8"), "percent")
  assert.equal(await readFile(join(resolved.path, "nested", "proof.txt"), "utf8"), "proof")
  assert.equal((await stat(join(resolved.path, "empty"))).isDirectory(), true)
})
