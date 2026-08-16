// Coverage for the single minting point of chat media. jsdom has no canvas, so
// `downscaleImage` / `measureImage` return their input unchanged — that is the
// documented degradation, and it lets these tests pin the policy (hashing,
// dedupe, GIF handling, original retention) without a real image codec. The
// re-encoding itself is covered by `packages/ocr`.

import {
  CANONICAL_MAX_LONG_EDGE,
  MAX_IMAGE_INPUT_BYTES,
  THUMBNAIL_MAX_LONG_EDGE,
  ingestImage,
  ingestImageDataUrl,
  sha256Hex,
} from "./ingest-media"
import { getMessageMedia, parseMediaRef } from "@/lib/db/message-media"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})

const bytesOf = (text: string) => new TextEncoder().encode(text)

// NOTE: `fake-indexeddb` does not round-trip a Blob — its structured clone
// returns an empty plain object, so nothing here can assert on stored blob
// CONTENT. Real IndexedDB (Chromium, WKWebView, WebView2) stores Blobs
// out-of-line, which is the whole point of using one. These tests therefore
// pin the policy that IS observable: addressing, dedupe, geometry, byte
// accounting and retention. The real round-trip is covered end-to-end in
// `tests/e2e/mobile/chat-render-perf.spec.ts`, which runs against a browser
// with a real IndexedDB.

afterAll(dbFixture.dispose)

describe("sha256Hex", () => {
  it("produces a stable 64-character hex digest", async () => {
    const hash = await sha256Hex(bytesOf("hello"))

    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(hash).toBe(await sha256Hex(bytesOf("hello")))
  })

  it("separates different content", async () => {
    expect(await sha256Hex(bytesOf("a"))).not.toBe(await sha256Hex(bytesOf("b")))
  })

  it("fails loudly rather than falling back to a weak hash", async () => {
    // A collision here would show the wrong image in someone's transcript, so
    // there is deliberately no non-crypto fallback.
    const real = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true })
    try {
      await expect(sha256Hex(bytesOf("x"))).rejects.toThrow(/crypto\.subtle/)
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true })
    }
  })
})

describe("ingestImage", () => {
  it("rejects images above the persistence input limit", async () => {
    const oversized = new Uint8Array(MAX_IMAGE_INPUT_BYTES + 1)

    await expect(ingestImage({ bytes: oversized, mediaType: "image/png" })).rejects.toThrow(
      /10 MiB/
    )
    expect(await getDb().messageMedia.count()).toBe(0)
  })

  it("stores the bytes and returns a reference plus geometry", async () => {
    const result = await ingestImage({ bytes: bytesOf("frame"), mediaType: "image/png" })

    expect(parseMediaRef(result.ref)).toHaveLength(64)
    expect(result.mediaType).toBe("image/png")
    expect(result.byteSize).toBe(5)

    const row = await getMessageMedia(result.ref)
    expect(row?.byteSize).toBe(5)
    expect(row?.mediaType).toBe("image/png")
  })

  it("addresses by content, so the same frame twice is stored once", async () => {
    const first = await ingestImage({ bytes: bytesOf("same"), mediaType: "image/png" })
    const second = await ingestImage({ bytes: bytesOf("same"), mediaType: "image/png" })

    expect(second.ref).toBe(first.ref)
    expect(await getDb().messageMedia.count()).toBe(1)
  })

  it("short-circuits a repeat frame without re-reading its geometry from scratch", async () => {
    const first = await ingestImage({ bytes: bytesOf("repeat"), mediaType: "image/png" })
    const second = await ingestImage({ bytes: bytesOf("repeat"), mediaType: "image/png" })

    // Same reported shape from the stored row, not from a fresh decode.
    expect(second).toEqual(first)
  })

  it("distinguishes different frames", async () => {
    const a = await ingestImage({ bytes: bytesOf("one"), mediaType: "image/png" })
    const b = await ingestImage({ bytes: bytesOf("two"), mediaType: "image/png" })

    expect(a.ref).not.toBe(b.ref)
    expect(await getDb().messageMedia.count()).toBe(2)
  })

  it("keeps an animated GIF untouched", async () => {
    // Every down-scale path is canvas-backed, and a canvas flattens an
    // animation to its first frame.
    const gif = bytesOf("GIF89a-animation")
    const result = await ingestImage({ bytes: gif, mediaType: "image/gif" })

    const row = await getMessageMedia(result.ref)
    expect(row?.mediaType).toBe("image/gif")
    expect(row?.byteSize).toBe(gif.byteLength)
    // No second encode: a thumbnail would be the first frame, not the animation.
    expect(row?.thumbBlob).toBeUndefined()
  })

  it("keeps no original for an agent frame", async () => {
    const result = await ingestImage({ bytes: bytesOf("screenshot"), mediaType: "image/png" })

    expect((await getMessageMedia(result.ref))?.originalBlob).toBeUndefined()
  })

  it("keeps no original when nothing was re-encoded", async () => {
    // jsdom cannot re-encode, so canonical IS the source — storing a second
    // identical copy would double the bytes for nothing.
    const result = await ingestImage({
      bytes: bytesOf("upload"),
      mediaType: "image/png",
      keepOriginal: true,
    })

    expect((await getMessageMedia(result.ref))?.originalBlob).toBeUndefined()
  })

  it("stamps createdAt and lastUsedAt from the injected clock", async () => {
    const result = await ingestImage({
      bytes: bytesOf("stamped"),
      mediaType: "image/png",
      now: () => 4_242,
    })

    const row = await getMessageMedia(result.ref)
    expect(row?.createdAt).toBe(4_242)
  })

  it("exposes the budgets it enforces", () => {
    // Pinned because the canonical edge has to match what the composer and the
    // model-facing path assume.
    expect(CANONICAL_MAX_LONG_EDGE).toBe(1568)
    expect(THUMBNAIL_MAX_LONG_EDGE).toBeLessThan(CANONICAL_MAX_LONG_EDGE)
  })
})

describe("ingestImageDataUrl", () => {
  it("ingests a data URL and reports its media type", async () => {
    const result = await ingestImageDataUrl("data:image/png;base64,aGVsbG8=")

    expect(result).not.toBeNull()
    expect(result!.mediaType).toBe("image/png")
    // "hello" base64-decodes to 5 bytes — proof the payload was decoded, not
    // stored as the base64 text.
    expect(result!.byteSize).toBe(5)
  })

  it("returns null for anything that is not a data URL", async () => {
    // Call sites hold values that may already be a reference, a remote URL or
    // a blob URL; the discrimination lives here rather than at each of them.
    expect(await ingestImageDataUrl("https://example.com/a.png")).toBeNull()
    expect(await ingestImageDataUrl("cognia-media:abc")).toBeNull()
    expect(await ingestImageDataUrl("")).toBeNull()
  })

  it("passes options through to the underlying ingest", async () => {
    const result = await ingestImageDataUrl("data:image/png;base64,aGk=", { now: () => 99 })

    expect((await getMessageMedia(result!.ref))?.createdAt).toBe(99)
  })
})
