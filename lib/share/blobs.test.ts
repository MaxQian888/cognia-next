import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

import { SHARE_BLOB_CHUNK_BYTES, SHARE_BLOB_CHUNK_OVERHEAD_BYTES } from "./blob-crypto"
import {
  ShareBlobRequestError,
  ShareFileChangedError,
  ShareFileIntegrityError,
  ShareFileUnavailableError,
  ShareTicketExpiredError,
  downloadShareBlob,
  hashShareBlobSource,
  prepareShareFileEntry,
  uploadShareBlob,
  type ShareBlobSource,
} from "./blobs"
import type { ShareFileEntry } from "./types"

const BASE = "https://share.example/"
const CODE = "AbCdEf123456"
const OWNER = "owner-token"
const TICKET = "ticket"
const MATERIAL = Uint8Array.from({ length: 32 }, (_, index) => index * 3)

function bytes(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length)
  for (let index = 0; index < length; index++) out[index] = (index * 31 + seed) & 0xff
  return out
}

function memorySource(data: Uint8Array): ShareBlobSource & { reads: number } {
  const source = {
    size: data.length,
    reads: 0,
    async read(offset: number, length: number) {
      source.reads++
      return data.slice(offset, offset + length)
    },
  }
  return source
}

/** An in-memory share server speaking the ADR-0222 blob routes. */
class FakeServer {
  chunks = new Map<string, Uint8Array>()
  committed = new Map<string, { chunkCount: number; totalBytes: number }>()
  failures: Array<{ match: RegExp; status: number }> = []
  inFlight = 0
  maxInFlight = 0
  /** How long a PUT takes to answer. */
  putDelayMs = 1
  requests: string[] = []

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET"
    this.requests.push(`${method} ${url}`)
    const failure = this.failures.findIndex((entry) => entry.match.test(`${method} ${url}`))
    if (failure >= 0) {
      const [{ status }] = this.failures.splice(failure, 1)
      return new Response(JSON.stringify({ error: "injected" }), { status })
    }
    const path = new URL(url).pathname
    const match = /^\/v1\/share\/([^/]+)\/blobs\/([^/]+)\/([^/]+)$/.exec(path)
    if (!match) return new Response(null, { status: 404 })
    const [, code, blobId, tail] = match
    const headers = new Headers(init?.headers)
    if (method === "PUT") {
      if (headers.get("X-Owner-Token") !== OWNER) return new Response(null, { status: 401 })
      this.inFlight++
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      await new Promise((resolve) => setTimeout(resolve, this.putDelayMs))
      this.inFlight--
      this.chunks.set(`${code}/${blobId}/${tail}`, new Uint8Array(init!.body as ArrayBuffer))
      return new Response(null, { status: 204 })
    }
    if (method === "POST" && tail === "commit") {
      const body = JSON.parse(init!.body as string) as { chunkCount: number; totalBytes: number }
      let total = 0
      for (let index = 0; index < body.chunkCount; index++) {
        const chunk = this.chunks.get(`${code}/${blobId}/${index}`)
        if (!chunk) return new Response(JSON.stringify({ error: "incomplete" }), { status: 400 })
        total += chunk.length
      }
      if (total !== body.totalBytes) return new Response(null, { status: 400 })
      this.committed.set(`${code}/${blobId}`, body)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (method === "GET") {
      if (headers.get("X-Read-Ticket") !== TICKET) return new Response(null, { status: 401 })
      if (!this.committed.has(`${code}/${blobId}`)) return new Response(null, { status: 404 })
      const chunk = this.chunks.get(`${code}/${blobId}/${tail}`)
      if (!chunk) return new Response(null, { status: 404 })
      return new Response(chunk.slice(), { status: 200 })
    }
    return new Response(null, { status: 405 })
  }
}

async function share(data: Uint8Array, server: FakeServer, path = "/workspace/a.bin") {
  const entry = await prepareShareFileEntry(
    { path, name: "a.bin", mime: "application/x-test" },
    memorySource(data)
  )
  await uploadShareBlob({
    baseUrl: BASE,
    code: CODE,
    ownerToken: OWNER,
    material: MATERIAL,
    entry,
    source: memorySource(data),
    fetchImpl: server.fetch,
    retryDelayMs: 0,
  })
  return entry
}

function download(entry: ShareFileEntry, server: FakeServer, overrides = {}) {
  return downloadShareBlob({
    baseUrl: BASE,
    code: CODE,
    readTicket: TICKET,
    material: MATERIAL,
    entry,
    fetchImpl: server.fetch,
    retryDelayMs: 0,
    ...overrides,
  })
}

async function blobBytes(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer())
}

/** Byte equality without Jest's element-by-element diff, which is slow on megabytes. */
function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return Buffer.from(actual).equals(Buffer.from(expected))
}

describe("prepareShareFileEntry", () => {
  it("hashes the whole file and sizes its chunks", async () => {
    const data = bytes(SHARE_BLOB_CHUNK_BYTES + 10)
    const progress: number[] = []
    const entry = await prepareShareFileEntry(
      { path: "/uploads/x.bin", name: "x.bin", mime: "" },
      memorySource(data),
      { onProgress: (done) => progress.push(done) }
    )
    expect(entry).toMatchObject({
      path: "/uploads/x.bin",
      name: "x.bin",
      mime: "application/octet-stream",
      size: data.length,
      sha256: bytesToHex(sha256(data)),
      chunkSize: SHARE_BLOB_CHUNK_BYTES,
      chunkCount: 2,
    })
    expect(progress).toEqual([SHARE_BLOB_CHUNK_BYTES, data.length])
  })

  it("notices a source that returns fewer bytes than it claimed", async () => {
    const source: ShareBlobSource = { size: 10, read: async () => new Uint8Array(4) }
    await expect(hashShareBlobSource(source, { path: "/w/f" })).rejects.toBeInstanceOf(
      ShareFileChangedError
    )
  })
})

describe("upload → download round trip", () => {
  it("restores a multi-chunk file byte for byte", async () => {
    const server = new FakeServer()
    const data = bytes(2 * SHARE_BLOB_CHUNK_BYTES + 123)
    const entry = await share(data, server)

    expect(server.committed.get(`${CODE}/${entry.blobId}`)).toEqual({
      chunkCount: 3,
      totalBytes: data.length + 3 * SHARE_BLOB_CHUNK_OVERHEAD_BYTES,
    })
    // The server holds ciphertext only.
    const stored = server.chunks.get(`${CODE}/${entry.blobId}/0`)!
    expect(stored).toHaveLength(SHARE_BLOB_CHUNK_BYTES + SHARE_BLOB_CHUNK_OVERHEAD_BYTES)
    expect(Buffer.from(stored.slice(0, 64)).equals(Buffer.from(data.slice(0, 64)))).toBe(false)

    const progress: number[] = []
    const blob = await download(entry, server, {
      onProgress: (done: number) => progress.push(done),
    })
    expect(blob.type).toBe("application/x-test")
    expect(sameBytes(await blobBytes(blob), data)).toBe(true)
    expect(progress.at(-1)).toBe(data.length)
  })

  it("keeps at most three uploads in flight", async () => {
    const server = new FakeServer()
    server.putDelayMs = 250
    await share(bytes(4 * SHARE_BLOB_CHUNK_BYTES + 1), server)
    expect(server.maxInFlight).toBeGreaterThan(1)
    expect(server.maxInFlight).toBeLessThanOrEqual(3)
  })

  it("uploads nothing for an empty file and downloads it as an empty blob", async () => {
    const server = new FakeServer()
    const entry = await share(new Uint8Array(), server)
    expect(entry.chunkCount).toBe(0)
    expect(server.requests).toEqual([])
    expect((await download(entry, server)).size).toBe(0)
  })

  it("retries transient failures on upload, commit and download", async () => {
    const server = new FakeServer()
    server.failures.push(
      { match: /^PUT .*\/0$/, status: 503 },
      { match: /^POST .*commit$/, status: 429 }
    )
    const data = bytes(1000)
    const entry = await share(data, server)
    server.failures.push({ match: /^GET .*\/0$/, status: 502 })
    expect(sameBytes(await blobBytes(await download(entry, server)), data)).toBe(true)
  })

  it("gives up after repeated transient failures", async () => {
    const server = new FakeServer()
    for (let index = 0; index < 4; index++) server.failures.push({ match: /^PUT/, status: 500 })
    await expect(share(bytes(10), server)).rejects.toBeInstanceOf(ShareBlobRequestError)
    expect(server.committed.size).toBe(0)
  })
})

describe("upload refusals", () => {
  it("does not commit a file that changed between the hash and the upload", async () => {
    const server = new FakeServer()
    const original = bytes(100)
    const entry = await prepareShareFileEntry(
      { path: "/workspace/a", name: "a", mime: "text/plain" },
      memorySource(original)
    )
    await expect(
      uploadShareBlob({
        baseUrl: BASE,
        code: CODE,
        ownerToken: OWNER,
        material: MATERIAL,
        entry,
        source: memorySource(bytes(100, 9)),
        fetchImpl: server.fetch,
        retryDelayMs: 0,
      })
    ).rejects.toBeInstanceOf(ShareFileChangedError)
    expect(server.committed.size).toBe(0)

    await expect(
      uploadShareBlob({
        baseUrl: BASE,
        code: CODE,
        ownerToken: OWNER,
        material: MATERIAL,
        entry,
        source: memorySource(bytes(101)),
        fetchImpl: server.fetch,
      })
    ).rejects.toBeInstanceOf(ShareFileChangedError)
  })

  it("maps a vanished share to ShareFileUnavailableError and stops", async () => {
    const server = new FakeServer()
    server.failures.push({ match: /^PUT .*\/0$/, status: 404 })
    await expect(share(bytes(3 * SHARE_BLOB_CHUNK_BYTES), server)).rejects.toBeInstanceOf(
      ShareFileUnavailableError
    )
    expect(server.committed.size).toBe(0)
  })

  it("stops when the caller aborts", async () => {
    const server = new FakeServer()
    const data = bytes(3 * SHARE_BLOB_CHUNK_BYTES)
    const entry = await prepareShareFileEntry(
      { path: "/w/a", name: "a", mime: "x/y" },
      memorySource(data)
    )
    const controller = new AbortController()
    const promise = uploadShareBlob({
      baseUrl: BASE,
      code: CODE,
      ownerToken: OWNER,
      material: MATERIAL,
      entry,
      source: memorySource(data),
      fetchImpl: server.fetch,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(server.committed.size).toBe(0)
  })
})

describe("download refusals", () => {
  it("reports an expired ticket", async () => {
    const server = new FakeServer()
    const entry = await share(bytes(10), server)
    await expect(download(entry, server, { readTicket: "stale" })).rejects.toBeInstanceOf(
      ShareTicketExpiredError
    )
  })

  it("reports a file the server no longer has", async () => {
    const server = new FakeServer()
    const entry = await share(bytes(10), server)
    server.committed.clear()
    await expect(download(entry, server)).rejects.toBeInstanceOf(ShareFileUnavailableError)
  })

  it("rejects altered, swapped or truncated chunks", async () => {
    const server = new FakeServer()
    const entry = await share(bytes(SHARE_BLOB_CHUNK_BYTES + 50), server)
    const zero = `${CODE}/${entry.blobId}/0`
    const one = `${CODE}/${entry.blobId}/1`

    const flipped = server.chunks.get(one)!.slice()
    flipped[3] ^= 0xff
    const original = server.chunks.get(one)!
    server.chunks.set(one, flipped)
    await expect(download(entry, server)).rejects.toBeInstanceOf(ShareFileIntegrityError)

    // A short chunk is refused before decryption.
    server.chunks.set(one, original.slice(0, 20))
    await expect(download(entry, server)).rejects.toBeInstanceOf(ShareFileIntegrityError)

    // Swapping two equal-length chunks fails authentication.
    server.chunks.set(one, original)
    const twoChunk = await share(bytes(2 * SHARE_BLOB_CHUNK_BYTES, 3), server)
    const a = `${CODE}/${twoChunk.blobId}/0`
    const b = `${CODE}/${twoChunk.blobId}/1`
    const first = server.chunks.get(a)!
    server.chunks.set(a, server.chunks.get(b)!)
    server.chunks.set(b, first)
    await expect(download(twoChunk, server)).rejects.toBeInstanceOf(ShareFileIntegrityError)
    expect(server.chunks.has(zero)).toBe(true)
  })

  it("rejects a manifest whose hash or key does not match", async () => {
    const server = new FakeServer()
    const entry = await share(bytes(10), server)
    await expect(download({ ...entry, sha256: "0".repeat(64) }, server)).rejects.toBeInstanceOf(
      ShareFileIntegrityError
    )
    await expect(download(entry, server, { material: new Uint8Array(32) })).rejects.toBeInstanceOf(
      ShareFileIntegrityError
    )
    await expect(download({ ...entry, chunkCount: 2 }, server)).rejects.toBeInstanceOf(
      ShareFileIntegrityError
    )
  })
})
