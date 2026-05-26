import {
  base64ToBytes,
  bytesToBase64,
  decryptWeComMedia,
  fetchAndDecryptMedia,
  uploadWeComMedia,
  type WeComRequestFn,
} from "./media"
import type { WeComFrameEnvelope } from "./protocol"

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })
})

describe("decryptWeComMedia", () => {
  it("decrypts AES-256-CBC ciphertext with IV = first 16 bytes of the key", async () => {
    // 32-byte key → AES-256; IV is its first 16 bytes.
    const key = new Uint8Array(32)
    for (let i = 0; i < 32; i++) key[i] = i
    const iv = key.slice(0, 16)
    const plaintext = new TextEncoder().encode("hello wecom media payload 12345")

    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, [
      "encrypt",
    ])
    const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, plaintext)

    const out = await decryptWeComMedia(ct, bytesToBase64(key))
    expect(new TextDecoder().decode(out)).toBe("hello wecom media payload 12345")
  })

  it("throws on an undersized key", async () => {
    await expect(
      decryptWeComMedia(new Uint8Array(16), bytesToBase64(new Uint8Array(8)))
    ).rejects.toThrow(/aeskey too short/)
  })
})

describe("fetchAndDecryptMedia", () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it("returns raw bytes when no aeskey is supplied", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    global.fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer,
    })) as unknown as typeof fetch
    const out = await fetchAndDecryptMedia("https://cdn/x")
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it("throws on a non-ok response", async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 403 })) as unknown as typeof fetch
    await expect(fetchAndDecryptMedia("https://cdn/x")).rejects.toThrow(/403/)
  })
})

describe("uploadWeComMedia", () => {
  it("runs init → chunk(s) → finish and returns the media_id", async () => {
    const calls: string[] = []
    const request: WeComRequestFn = jest.fn(async (frame: WeComFrameEnvelope) => {
      calls.push(frame.cmd ?? "")
      if (frame.cmd === "aibot_upload_media_init") return { body: { upload_id: "up1" } }
      if (frame.cmd === "aibot_upload_media_finish") return { body: { media_id: "media-xyz" } }
      return { errcode: 0 }
    })
    const bytes = new Uint8Array(10)
    const id = await uploadWeComMedia(request, "adp", bytes, "a.png", "image")
    expect(id).toBe("media-xyz")
    expect(calls).toEqual([
      "aibot_upload_media_init",
      "aibot_upload_media_chunk",
      "aibot_upload_media_finish",
    ])
  })

  it("rejects payloads over the 20MB cap", async () => {
    const request: WeComRequestFn = jest.fn(async () => ({ errcode: 0 }))
    await expect(
      uploadWeComMedia(request, "adp", new Uint8Array(21 * 1024 * 1024), "big.bin", "file")
    ).rejects.toThrow(/20MB/)
  })

  it("throws when init returns no upload_id", async () => {
    const request: WeComRequestFn = jest.fn(async () => ({ errcode: 0 }))
    await expect(
      uploadWeComMedia(request, "adp", new Uint8Array(4), "a.bin", "file")
    ).rejects.toThrow(/no upload_id/)
  })
})
