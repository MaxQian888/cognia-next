import { BM25Index } from "./hybrid-search"
import { decryptBM25Segment, encryptBM25Segment } from "./bm25-segment"

describe("encrypted BM25 segment", () => {
  it("uses one portable encrypted format without plaintext terms", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    const index = new BM25Index()
    index.addDocument("chunk-1", "private-memory-term 中文检索")
    const segment = await encryptBM25Segment(
      index,
      {
        corpusId: "memory:profile-1",
        generationId: "generation-1",
        profileFingerprint: "fingerprint-1",
        ordinal: 0,
      },
      { key, keyId: "dek-1" }
    )

    expect(JSON.stringify(segment)).not.toContain("private-memory-term")
    const restored = await decryptBM25Segment(segment, { key })
    expect(restored.search("private-memory-term")).toMatchObject([{ id: "chunk-1" }])
  })

  it("rejects identity tampering through authenticated additional data", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    const segment = await encryptBM25Segment(
      new BM25Index(),
      {
        corpusId: "kb:1",
        generationId: "generation-1",
        profileFingerprint: "fingerprint-1",
        ordinal: 0,
      },
      { key, keyId: "dek-1" }
    )

    segment.identity.generationId = "generation-2"
    await expect(decryptBM25Segment(segment, { key })).rejects.toThrow("AAD hash mismatch")
  })
})
