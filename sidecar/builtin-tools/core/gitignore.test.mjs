import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { gitignoreLineToGlobs, loadIgnoreGlobs, ALWAYS_IGNORE } from "./gitignore.mjs"

test("comments, blanks, and negations produce no globs", () => {
  assert.deepEqual(gitignoreLineToGlobs("# comment"), [])
  assert.deepEqual(gitignoreLineToGlobs("   "), [])
  assert.deepEqual(gitignoreLineToGlobs("!keep.log"), [])
})

test("bare name matches at any depth, with contents", () => {
  assert.deepEqual(gitignoreLineToGlobs("node_modules"), ["**/node_modules", "**/node_modules/**"])
})

test("directory-only pattern keeps any-depth semantics", () => {
  assert.deepEqual(gitignoreLineToGlobs("build/"), ["**/build", "**/build/**"])
})

test("leading slash anchors to the root", () => {
  assert.deepEqual(gitignoreLineToGlobs("/out"), ["out", "out/**"])
})

test("pattern with an inner slash is root-anchored", () => {
  assert.deepEqual(gitignoreLineToGlobs("docs/tmp"), ["docs/tmp", "docs/tmp/**"])
})

test("wildcard extension pattern", () => {
  assert.deepEqual(gitignoreLineToGlobs("*.log"), ["**/*.log", "**/*.log/**"])
})

test("loadIgnoreGlobs reads the root .gitignore and always ignores .git", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gi-"))
  try {
    await fsp.writeFile(path.join(dir, ".gitignore"), "dist/\n#c\n!keep\n*.tmp\n")
    const globs = await loadIgnoreGlobs(dir)
    for (const a of ALWAYS_IGNORE) assert.ok(globs.includes(a))
    assert.ok(globs.includes("**/dist"))
    assert.ok(globs.includes("**/*.tmp"))
    assert.ok(!globs.some((g) => g.includes("keep")))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("loadIgnoreGlobs without a .gitignore returns only defaults", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gi-"))
  try {
    const globs = await loadIgnoreGlobs(dir)
    assert.deepEqual(globs, [...ALWAYS_IGNORE])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("loadIgnoreGlobs anchors nested .gitignore patterns to their directory", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gi-"))
  try {
    await fsp.writeFile(path.join(dir, ".gitignore"), "*.log\n")
    await fsp.mkdir(path.join(dir, "pkg"), { recursive: true })
    await fsp.writeFile(path.join(dir, "pkg", ".gitignore"), "dist/\nlocal.txt\n")
    const globs = await loadIgnoreGlobs(dir)
    // Root pattern stays unanchored.
    assert.ok(globs.includes("**/*.log"))
    // Nested patterns are scoped under their directory.
    assert.ok(globs.includes("pkg/**/dist"))
    assert.ok(globs.includes("pkg/**/local.txt"))
    // A nested pattern must NOT leak to the root scope.
    assert.ok(!globs.includes("**/dist"))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
