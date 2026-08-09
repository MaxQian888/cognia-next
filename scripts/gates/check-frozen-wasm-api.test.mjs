import assert from "node:assert/strict"
import test from "node:test"

import { auditFrozen, digest } from "./check-frozen-wasm-api.mjs"

const WIT = "package cognia:plugin@0.1.0;\n"
const LINKER = "// since_v0_1.rs\n"

/** A manifest + fake filesystem that agree, i.e. a clean freeze. */
const clean = () => {
  const disk = new Map([
    ["cognia-plugin.wit", WIT],
    ["since_v0_1.rs", LINKER],
  ])
  return {
    disk,
    manifest: {
      root: "crates/cognia-plugin-runtime/frozen/v0_1",
      files: [
        { path: "cognia-plugin.wit", sha256: digest(WIT), bytes: Buffer.byteLength(WIT) },
        { path: "since_v0_1.rs", sha256: digest(LINKER), bytes: Buffer.byteLength(LINKER) },
      ],
    },
  }
}

const audit = ({ manifest, disk }) =>
  auditFrozen({
    manifest,
    listFiles: async () => [...disk.keys()].sort(),
    readFile: async (relPath) => {
      if (!disk.has(relPath)) throw new Error("ENOENT")
      return Buffer.from(disk.get(relPath))
    },
  })

test("passes when every frozen file matches the manifest", async () => {
  const { ok, problems } = await audit(clean())
  assert.equal(ok, true)
  assert.deepEqual(problems, [])
})

test("direction 1: catches an edit to a frozen file", async () => {
  const fixture = clean()
  // Same byte length, different content — a size-only check would miss this.
  fixture.disk.set("cognia-plugin.wit", "package cognia:plugin@0.9.0;\n")

  const { ok, problems } = await audit(fixture)
  assert.equal(ok, false)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /content changed: cognia-plugin\.wit/)
})

test("direction 1: reports a size change alongside the digest mismatch", async () => {
  const fixture = clean()
  fixture.disk.set("since_v0_1.rs", `${LINKER}// appended\n`)

  const { problems } = await audit(fixture)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /size changed: since_v0_1\.rs/)
  assert.match(problems[1], /content changed: since_v0_1\.rs/)
})

test("direction 2: catches a new file dropped into the frozen directory", async () => {
  // The review-evasion case: everything listed still matches, but something
  // extra was smuggled in alongside it.
  const fixture = clean()
  fixture.disk.set("since_v0_1_patched.rs", "// sneaky\n")

  const { ok, problems } = await audit(fixture)
  assert.equal(ok, false)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /unlisted file present: since_v0_1_patched\.rs/)
})

test("direction 3: catches a deleted frozen file", async () => {
  const fixture = clean()
  fixture.disk.delete("since_v0_1.rs")

  const { ok, problems } = await audit(fixture)
  assert.equal(ok, false)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /missing from disk: since_v0_1\.rs/)
})

test("reports every problem at once rather than stopping at the first", async () => {
  const fixture = clean()
  fixture.disk.set("cognia-plugin.wit", "package cognia:plugin@0.9.0;\n")
  fixture.disk.delete("since_v0_1.rs")
  fixture.disk.set("extra.rs", "// extra\n")

  const { ok, problems } = await audit(fixture)
  assert.equal(ok, false)
  assert.equal(problems.length, 3)
})

test("an unreadable frozen root is a failure, not a silent pass", async () => {
  const { manifest, disk } = clean()
  const { ok, problems } = await auditFrozen({
    manifest,
    listFiles: async () => {
      throw new Error("EACCES")
    },
    readFile: async (relPath) => Buffer.from(disk.get(relPath)),
  })

  assert.equal(ok, false)
  assert.match(problems[0], /cannot list crates\/cognia-plugin-runtime\/frozen\/v0_1: EACCES/)
})

test("digest is stable and matches sha256 of the exact bytes", () => {
  // Empty-string sha256 — a fixed, externally verifiable vector.
  assert.equal(digest(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  assert.equal(digest("abc"), digest(Buffer.from("abc")))
})
