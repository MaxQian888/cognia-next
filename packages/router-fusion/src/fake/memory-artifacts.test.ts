import { sha256Hex } from "../util/sha256"
import { MemoryArtifactStore } from "./memory-artifacts"

describe("MemoryArtifactStore", () => {
  it("content-addresses what it stores and hands it back by id", async () => {
    const store = new MemoryArtifactStore()
    const artifact = await store.put("claim: the sky is blue", "text/plain", "panel:evidence")
    expect(artifact).toMatchObject({
      contentSha256: sha256Hex("claim: the sky is blue"),
      sizeBytes: 22,
      mediaType: "text/plain",
    })
    await expect(store.get(artifact.artifactId)).resolves.toEqual({
      content: "claim: the sky is blue",
      artifact,
    })
    expect(store.items.get(artifact.artifactId)?.namespace).toBe("panel:evidence")
  })

  it("counts a multi-byte character by its bytes, not its length", async () => {
    const store = new MemoryArtifactStore()
    const artifact = await store.put("héllo", "text/plain", "ns")
    expect(artifact.sizeBytes).toBe(6)
  })

  it("gives every artifact its own id and answers null for one it never stored", async () => {
    const store = new MemoryArtifactStore()
    const first = await store.put("a", "text/plain", "ns")
    const second = await store.put("a", "text/plain", "ns")
    expect(first.artifactId).not.toBe(second.artifactId)
    expect(first.contentSha256).toBe(second.contentSha256)
    await expect(store.get("00000000-0000-4000-8000-ffffffffffff")).resolves.toBeNull()
  })
})
