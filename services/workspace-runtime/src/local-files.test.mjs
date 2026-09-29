import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  isWithin,
  reserveUniquePath,
  resolveLocalUploads,
  safeFilename,
  splitExtension,
} from "./local-files.mjs"

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-local-files-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return fs.realpath(dir)
}

test("safeFilename keeps one sanitized path segment", () => {
  assert.equal(safeFilename("../../etc/passwd"), "passwd")
  assert.equal(safeFilename("..\\..\\boot.ini"), "boot.ini")
  assert.equal(safeFilename('a<b>c:d"e|f?g*h.txt'), "a_b_c_d_e_f_g_h.txt")
  assert.equal(safeFilename("bad\u0000name\u0007.pdf"), "bad_name_.pdf")
  assert.equal(safeFilename(".."), "download")
  assert.equal(safeFilename(""), "download")
  assert.equal(safeFilename("", "page"), "page")
  assert.equal(safeFilename("x".repeat(300)).length, 200)
})

test("splitExtension understands compound tar extensions and dotfiles", () => {
  assert.deepEqual(splitExtension("report.pdf"), { stem: "report", extension: ".pdf" })
  assert.deepEqual(splitExtension("src.tar.gz"), { stem: "src", extension: ".tar.gz" })
  assert.deepEqual(splitExtension("README"), { stem: "README", extension: "" })
  assert.deepEqual(splitExtension(".env"), { stem: ".env", extension: "" })
})

test("reserveUniquePath appends (n) before the extension on collisions", async (t) => {
  const dir = await tempDir(t)
  const first = await reserveUniquePath(dir, "report.pdf")
  const second = await reserveUniquePath(dir, "report.pdf")
  const third = await reserveUniquePath(dir, "report.pdf")
  const archive = await reserveUniquePath(dir, "src.tar.gz")
  const archive2 = await reserveUniquePath(dir, "src.tar.gz")
  assert.equal(path.basename(first), "report.pdf")
  assert.equal(path.basename(second), "report (1).pdf")
  assert.equal(path.basename(third), "report (2).pdf")
  assert.equal(path.basename(archive), "src.tar.gz")
  assert.equal(path.basename(archive2), "src (1).tar.gz")
})

test("reserveUniquePath never picks the same name for concurrent reservations", async (t) => {
  const dir = await tempDir(t)
  const paths = await Promise.all(
    Array.from({ length: 8 }, () => reserveUniquePath(dir, "same.txt"))
  )
  assert.equal(new Set(paths).size, 8)
})

test("reserveUniquePath creates the downloads directory", async (t) => {
  const dir = await tempDir(t)
  const nested = path.join(dir, "a", "b")
  const reserved = await reserveUniquePath(nested, "../escape.txt")
  assert.equal(path.dirname(reserved), nested)
  assert.equal(path.basename(reserved), "escape.txt")
})

test("resolveLocalUploads confines absolute paths to the upload roots", async (t) => {
  const dir = await tempDir(t)
  const root = path.join(dir, "root")
  const outside = path.join(dir, "outside")
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.writeFile(path.join(root, "ok.txt"), "ok")
  await fs.writeFile(path.join(outside, "secret.txt"), "no")
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"))

  assert.deepEqual(await resolveLocalUploads([path.join(root, "ok.txt")], [root]), [
    path.join(root, "ok.txt"),
  ])
  await assert.rejects(
    () => resolveLocalUploads([path.join(outside, "secret.txt")], [root]),
    (error) => error.code === "browser_upload_path_denied"
  )
  await assert.rejects(
    () => resolveLocalUploads([path.join(root, "link.txt")], [root]),
    (error) => error.code === "browser_upload_path_denied"
  )
  await assert.rejects(
    () => resolveLocalUploads(["relative.txt"], [root]),
    (error) => error.code === "browser_upload_path_denied"
  )
  await assert.rejects(
    () => resolveLocalUploads([path.join(root, "ok.txt")], []),
    (error) => error.code === "browser_upload_path_denied"
  )
  await assert.rejects(
    () => resolveLocalUploads([path.join(root, "missing.txt")], [root]),
    (error) => error.code === "browser_upload_not_found"
  )
  await assert.rejects(
    () => resolveLocalUploads([root], [root]),
    (error) => error.code === "browser_upload_invalid"
  )
  await assert.rejects(
    () => resolveLocalUploads([path.join(root, "ok.txt")], [root], { maxFileBytes: 1 }),
    (error) => error.code === "browser_upload_too_large"
  )
  assert.equal(isWithin(root, path.join(root, "a")), true)
  assert.equal(isWithin(root, outside), false)
})

test("resolveLocalUploads compares realpaths, so a symlinked root and aliases still confine", async (t) => {
  const dir = await tempDir(t)
  const root = path.join(dir, "root")
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, "ok.txt"), "ok")
  // The configured root is itself a symlink: it is resolved before comparing.
  const aliasRoot = path.join(dir, "alias-root")
  await fs.symlink(root, aliasRoot)
  assert.deepEqual(await resolveLocalUploads([path.join(aliasRoot, "ok.txt")], [aliasRoot]), [
    path.join(root, "ok.txt"),
  ])
  // A symlinked directory inside the root that escapes it is refused.
  const outside = path.join(dir, "outside")
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, "secret.txt"), "no")
  await fs.symlink(outside, path.join(root, "escape"))
  await assert.rejects(
    () => resolveLocalUploads([path.join(root, "escape", "secret.txt")], [root]),
    (error) => error.code === "browser_upload_path_denied"
  )
  // `..` segments cannot climb out either.
  await assert.rejects(
    () => resolveLocalUploads([path.join(root, "..", "outside", "secret.txt")], [root]),
    (error) => error.code === "browser_upload_path_denied"
  )
})

test("resolveLocalUploads refuses dotfiles and files inside dot-directories", async (t) => {
  const dir = await tempDir(t)
  const root = path.join(dir, "root")
  await fs.mkdir(path.join(root, ".ssh"), { recursive: true })
  await fs.mkdir(path.join(root, "docs"))
  await fs.writeFile(path.join(root, ".env"), "SECRET=1")
  await fs.writeFile(path.join(root, ".ssh", "id_ed25519"), "key")
  await fs.writeFile(path.join(root, "docs", "cv.pdf"), "cv")
  // A visible name that resolves to a hidden file is refused too.
  await fs.symlink(path.join(root, ".ssh", "id_ed25519"), path.join(root, "docs", "key.txt"))
  // A hidden name that resolves to a visible file is refused as well.
  await fs.symlink(path.join(root, "docs", "cv.pdf"), path.join(root, ".cv-link"))

  for (const candidate of [
    path.join(root, ".env"),
    path.join(root, ".ssh", "id_ed25519"),
    path.join(root, "docs", "key.txt"),
    path.join(root, ".cv-link"),
  ]) {
    await assert.rejects(
      () => resolveLocalUploads([candidate], [root]),
      (error) => error.code === "browser_upload_path_denied" && /Hidden/.test(error.message),
      candidate
    )
  }
  assert.deepEqual(await resolveLocalUploads([path.join(root, "docs", "cv.pdf")], [root]), [
    path.join(root, "docs", "cv.pdf"),
  ])
  // A root that is itself under a dot-directory still works for visible files.
  const hiddenRoot = path.join(dir, ".config", "uploads")
  await fs.mkdir(hiddenRoot, { recursive: true })
  await fs.writeFile(path.join(hiddenRoot, "photo.png"), "png")
  assert.deepEqual(await resolveLocalUploads([path.join(hiddenRoot, "photo.png")], [hiddenRoot]), [
    path.join(hiddenRoot, "photo.png"),
  ])
})
