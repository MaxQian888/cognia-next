import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import crypto from "node:crypto"

import { digestFile, execFileHash } from "./file-hash.mjs"

let TMP
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-hash-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function decode(result) {
  return JSON.parse(result.content[0].text)
}

test("file_hash returns sha256 by default", async () => {
  const target = path.join(TMP, "h.txt")
  fs.writeFileSync(target, "hello world")
  const expected = crypto.createHash("sha256").update("hello world").digest("hex")
  const r = await execFileHash({ path: target, algorithm: "sha256" })
  assert.equal(r.isError, undefined)
  const data = decode(r)
  assert.equal(data.digest, expected)
  assert.equal(data.algorithm, "sha256")
  assert.equal(data.size, 11)
})

test("file_hash supports md5 / sha1 / sha512", async () => {
  const target = path.join(TMP, "hash-multi.txt")
  fs.writeFileSync(target, "x")
  for (const algo of ["md5", "sha1", "sha512"]) {
    const r = await execFileHash({ path: target, algorithm: algo })
    assert.equal(r.isError, undefined)
    const got = decode(r).digest
    const want = crypto.createHash(algo).update("x").digest("hex")
    assert.equal(got, want, `${algo} mismatch`)
  }
})

test("file_hash falls back to Node when Bun hashing capabilities are partial", async () => {
  const target = path.join(TMP, "hash-partial-runtime.txt")
  fs.writeFileSync(target, "portable")
  const expected = crypto.createHash("sha256").update("portable").digest("hex")
  const partialBun = {
    file() {
      throw new Error("partial Bun.file must not be selected")
    },
  }

  assert.equal(await digestFile(target, "sha256", partialBun), expected)
})

test("file_hash errors on missing file", async () => {
  const r = await execFileHash({ path: path.join(TMP, "nope.txt"), algorithm: "sha256" })
  assert.equal(r.isError, true)
})

test("file_hash rejects directories", async () => {
  const r = await execFileHash({ path: TMP, algorithm: "sha256" })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not a regular file/)
})
