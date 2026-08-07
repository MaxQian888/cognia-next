import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { fetchCorpusFile, validateCorpusCatalog } from "./fetch-live2d-corpus.mjs"

const sha256 = (value) => createHash("sha256").update(value).digest("hex")

test("the public corpus is revision-pinned and every asset has an integrity", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../../test-fixtures/pet/live2d-public-corpus.json", import.meta.url))
  )

  assert.deepEqual(validateCorpusCatalog(catalog), { models: 2, files: 40 })
  for (const model of Object.values(catalog)) {
    assert.match(model.revision, /^[0-9a-f]{40}$/)
    assert.ok(model.baseUrl.includes(model.revision))
  }
})

test("downloads to cache, verifies sha256, and reuses the verified file", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "cognia-pet-corpus-"))
  const bytes = new TextEncoder().encode("model payload")
  const asset = { path: "nested/model.bin", sha256: sha256(bytes), bytes: bytes.byteLength }
  let requests = 0
  const fetchImpl = async () => {
    requests += 1
    return new Response(bytes)
  }

  try {
    const first = await fetchCorpusFile({
      modelId: "sample",
      baseUrl: "https://example.invalid/revision/",
      asset,
      cacheDir,
      fetchImpl,
    })
    const second = await fetchCorpusFile({
      modelId: "sample",
      baseUrl: "https://example.invalid/revision/",
      asset,
      cacheDir,
      fetchImpl,
    })

    assert.equal(first, second)
    assert.deepEqual(new Uint8Array(await readFile(first)), bytes)
    assert.equal(requests, 1)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("rejects a response whose bytes do not match the pinned integrity", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "cognia-pet-corpus-"))
  try {
    await assert.rejects(
      fetchCorpusFile({
        modelId: "sample",
        baseUrl: "https://example.invalid/revision/",
        asset: { path: "model.bin", sha256: sha256("expected"), bytes: 8 },
        cacheDir,
        fetchImpl: async () => new Response("tampered"),
      }),
      /integrity mismatch/
    )
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})
