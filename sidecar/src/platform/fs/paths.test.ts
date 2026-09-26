import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assertPathInside, normaliseAbsolutePath, resolveToolPath } from "./paths.ts"

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cognia-safety-${prefix}-`))
  return dir
}

test("assertPathInside accepts a child path", () => {
  const root = mkTmp("inside")
  const target = path.join(root, "child.txt")
  fs.writeFileSync(target, "x")
  const ok = assertPathInside(root, target)
  assert.equal(ok, fs.realpathSync.native(target))
  fs.rmSync(root, { recursive: true, force: true })
})

test("assertPathInside accepts a relative path resolved against root", () => {
  const root = mkTmp("rel")
  fs.writeFileSync(path.join(root, "child.txt"), "x")
  const ok = assertPathInside(root, "child.txt")
  assert.ok(ok.endsWith("child.txt"))
  fs.rmSync(root, { recursive: true, force: true })
})

test("assertPathInside accepts the root itself", () => {
  const root = mkTmp("root")
  const ok = assertPathInside(root, root)
  assert.equal(ok, fs.realpathSync.native(root))
  fs.rmSync(root, { recursive: true, force: true })
})

test("assertPathInside rejects ../ traversal", () => {
  const root = mkTmp("traversal")
  // Build a sibling file outside root.
  const outside = path.join(path.dirname(root), `outside-${Date.now()}.txt`)
  fs.writeFileSync(outside, "x")
  assert.throws(
    () => assertPathInside(root, path.join(root, "..", path.basename(outside))),
    /escapes root/
  )
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { force: true })
})

test("assertPathInside rejects unrelated absolute paths", () => {
  const root = mkTmp("abs")
  const elsewhere = mkTmp("elsewhere")
  assert.throws(() => assertPathInside(root, path.join(elsewhere, "x")), /escapes root/)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(elsewhere, { recursive: true, force: true })
})

test("assertPathInside requires non-empty inputs", () => {
  assert.throws(() => assertPathInside("", "/x"), /rootCwd/)
  assert.throws(() => assertPathInside("/x", ""), /target/)
})

test("assertPathInside doesn't confuse '/aa' with '/a' as a prefix", () => {
  const a = mkTmp("dir-a")
  const aa = a + "a"
  fs.mkdirSync(aa, { recursive: true })
  assert.throws(() => assertPathInside(a, aa), /escapes root/)
  fs.rmSync(a, { recursive: true, force: true })
  fs.rmSync(aa, { recursive: true, force: true })
})

test("assertPathInside tolerates non-existent targets (write paths)", () => {
  const root = mkTmp("write")
  const target = path.join(root, "subdir", "newfile.txt")
  // Doesn't exist yet — should still be inside root.
  const ok = assertPathInside(root, target)
  assert.ok(ok.startsWith(fs.realpathSync.native(root)))
  fs.rmSync(root, { recursive: true, force: true })
})

test("normaliseAbsolutePath returns a resolved absolute path", () => {
  const got = normaliseAbsolutePath("./foo")
  assert.ok(path.isAbsolute(got))
})

test("normaliseAbsolutePath rejects empty input", () => {
  assert.throws(() => normaliseAbsolutePath(""))
})

test("resolveToolPath resolves relative against cwd and passes absolutes through", () => {
  const abs = path.resolve("/tmp/abs.txt")
  assert.equal(resolveToolPath("/base", abs), path.normalize(abs))
  assert.equal(resolveToolPath(os.tmpdir(), "rel.txt"), path.join(os.tmpdir(), "rel.txt"))
})
