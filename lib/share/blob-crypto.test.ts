import { createCipheriv, hkdfSync } from "node:crypto"

import constants from "@/protocol/cognia-services/share-constants.json"

import {
  SHARE_BLOB_CHUNK_BYTES,
  SHARE_BLOB_CHUNK_OVERHEAD_BYTES,
  SHARE_BLOB_ID_BYTES,
  SHARE_MAX_BLOBS,
  SHARE_MAX_BLOB_BYTES,
  SHARE_MAX_TOTAL_BLOB_BYTES,
  SHARE_READ_TICKET_TTL_SECONDS,
  decryptShareBlobChunk,
  deriveShareBlobKey,
  encryptShareBlobChunk,
  isShareBlobId,
  newShareBlobId,
  newShareBlobIvPrefix,
  shareBlobChunkAad,
  shareBlobChunkCount,
  shareBlobChunkIv,
  shareBlobChunkLength,
  shareBlobStoredBytes,
  type ShareBlobChunkRef,
} from "./blob-crypto"
import { decodeBase64Url } from "./encoding"

const MATERIAL = Uint8Array.from({ length: 32 }, (_, index) => index)
const BLOB_ID = "AAECAwQFBgcICQoLDA0ODw" // bytes 0..15
const IV_PREFIX = "8PHy8/T19vc=" // bytes f0..f7

function ref(overrides: Partial<ShareBlobChunkRef> = {}): ShareBlobChunkRef {
  return {
    code: "AbCdEf123456",
    blobId: BLOB_ID,
    ivPrefix: IV_PREFIX,
    index: 1,
    chunkCount: 3,
    ...overrides,
  }
}

describe("limits", () => {
  it("match the share server's constants", () => {
    expect(SHARE_BLOB_CHUNK_BYTES).toBe(constants.blobChunkBytes)
    expect(SHARE_BLOB_CHUNK_OVERHEAD_BYTES).toBe(constants.blobChunkOverheadBytes)
    expect(SHARE_BLOB_ID_BYTES).toBe(constants.blobIdBytes)
    expect(SHARE_MAX_BLOB_BYTES).toBe(constants.maxBlobBytes)
    expect(SHARE_MAX_TOTAL_BLOB_BYTES).toBe(constants.maxShareBlobBytes)
    expect(SHARE_MAX_BLOBS).toBe(constants.maxBlobsPerShare)
    expect(SHARE_READ_TICKET_TTL_SECONDS).toBe(constants.readTicketTtlSeconds)
  })

  it("cuts files into full chunks and a short last one", () => {
    expect(shareBlobChunkCount(0)).toBe(0)
    expect(shareBlobChunkCount(1)).toBe(1)
    expect(shareBlobChunkCount(SHARE_BLOB_CHUNK_BYTES)).toBe(1)
    expect(shareBlobChunkCount(SHARE_BLOB_CHUNK_BYTES + 1)).toBe(2)
    expect(shareBlobChunkLength(SHARE_BLOB_CHUNK_BYTES + 5, 0)).toBe(SHARE_BLOB_CHUNK_BYTES)
    expect(shareBlobChunkLength(SHARE_BLOB_CHUNK_BYTES + 5, 1)).toBe(5)
    expect(shareBlobStoredBytes(SHARE_BLOB_CHUNK_BYTES + 5)).toBe(SHARE_BLOB_CHUNK_BYTES + 5 + 32)
    expect(shareBlobStoredBytes(0)).toBe(0)
  })
})

describe("ids", () => {
  it("mints 22-character base64url blob ids and 8-byte IV prefixes", () => {
    const id = newShareBlobId()
    expect(isShareBlobId(id)).toBe(true)
    expect(decodeBase64Url(id)).toHaveLength(16)
    expect(newShareBlobId()).not.toBe(id)
    expect(Buffer.from(newShareBlobIvPrefix(), "base64")).toHaveLength(8)
  })

  it("refuses anything but an exact blob id", () => {
    expect(isShareBlobId(BLOB_ID)).toBe(true)
    expect(isShareBlobId(BLOB_ID.slice(1))).toBe(false)
    expect(isShareBlobId("../AAAAAAAAAAAAAAAAAAA")).toBe(false)
    expect(isShareBlobId("AAAAAAAAAAAAAAAAAAAA+/")).toBe(false)
  })
})

describe("IV and AAD layout", () => {
  it("puts the chunk index after the blob's prefix", () => {
    expect(Buffer.from(shareBlobChunkIv(IV_PREFIX, 0x01020304)).toString("hex")).toBe(
      "f0f1f2f3f4f5f6f701020304"
    )
    expect(() => shareBlobChunkIv("AAAA", 0)).toThrow(/IV prefix/)
  })

  it("binds code, blob, index and chunk count", () => {
    const aad = shareBlobChunkAad({ code: "AB", blobId: "cd", index: 2, chunkCount: 5 })
    expect(Buffer.from(aad).toString("hex")).toBe("4142006364000000000200000005")
  })
})

describe("chunk encryption", () => {
  it("matches an independent HKDF + AES-GCM implementation", async () => {
    const plaintext = new TextEncoder().encode("hello, shared file")
    const key = await deriveShareBlobKey(MATERIAL, BLOB_ID)
    const ours = await encryptShareBlobChunk(key, ref(), plaintext)

    const fileKey = Buffer.from(
      hkdfSync(
        "sha256",
        MATERIAL,
        decodeBase64Url(BLOB_ID),
        Buffer.from("cognia-share-blob-v1"),
        32
      )
    )
    const cipher = createCipheriv("aes-256-gcm", fileKey, shareBlobChunkIv(IV_PREFIX, 1))
    cipher.setAAD(shareBlobChunkAad(ref()))
    const reference = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

    expect(Buffer.from(ours).toString("hex")).toBe(reference.toString("hex"))
    expect(ours).toHaveLength(plaintext.length + SHARE_BLOB_CHUNK_OVERHEAD_BYTES)
    await expect(decryptShareBlobChunk(key, ref(), ours)).resolves.toEqual(plaintext)
  })

  it("fails authentication when a chunk is moved, truncated, spliced or altered", async () => {
    const key = await deriveShareBlobKey(MATERIAL, BLOB_ID)
    const sealed = await encryptShareBlobChunk(key, ref(), new Uint8Array([1, 2, 3, 4]))

    // Reordered: the same bytes presented as another chunk.
    await expect(decryptShareBlobChunk(key, ref({ index: 0 }), sealed)).rejects.toBeDefined()
    // Truncated blob: the reader believes there are fewer chunks.
    await expect(decryptShareBlobChunk(key, ref({ chunkCount: 2 }), sealed)).rejects.toBeDefined()
    // Spliced from another share.
    await expect(
      decryptShareBlobChunk(key, ref({ code: "Other1234567" }), sealed)
    ).rejects.toBeDefined()
    // Spliced from another blob of the same share: a different key.
    const otherBlob = "Dw4NDAsKCQgHBgUEAwIBAA"
    const otherKey = await deriveShareBlobKey(MATERIAL, otherBlob)
    await expect(
      decryptShareBlobChunk(otherKey, ref({ blobId: otherBlob }), sealed)
    ).rejects.toBeDefined()
    // A flipped byte.
    const altered = sealed.slice()
    altered[0] ^= 1
    await expect(decryptShareBlobChunk(key, ref(), altered)).rejects.toBeDefined()
    // Wrong key material (e.g. no passphrase).
    const wrong = await deriveShareBlobKey(new Uint8Array(32), BLOB_ID)
    await expect(decryptShareBlobChunk(wrong, ref(), sealed)).rejects.toBeDefined()
  })

  it("refuses positions outside the blob and empty or oversized chunks", async () => {
    const key = await deriveShareBlobKey(MATERIAL, BLOB_ID)
    await expect(
      encryptShareBlobChunk(key, ref({ index: 3 }), new Uint8Array([1]))
    ).rejects.toThrow(RangeError)
    await expect(encryptShareBlobChunk(key, ref(), new Uint8Array())).rejects.toThrow(RangeError)
    await expect(
      encryptShareBlobChunk(key, ref(), new Uint8Array(SHARE_BLOB_CHUNK_BYTES + 1))
    ).rejects.toThrow(RangeError)
    await expect(deriveShareBlobKey(MATERIAL, "short")).rejects.toThrow(/blob id/)
  })
})
