import { MemoryArtifactStore } from "./memory-artifacts"
import { MemoryEvidenceResolver } from "./memory-evidence"

describe("MemoryEvidenceResolver", () => {
  it("resolves stored content, and refuses what it cannot vouch for", async () => {
    const store = new MemoryArtifactStore()
    const kept = await store.put("fact", "text/plain", "mine")
    const hidden = await store.put("secret", "text/plain", "theirs")
    const resolver = new MemoryEvidenceResolver(store, (_id, namespace) => namespace === "mine")
    const ref = (artifactId: string, contentSha256: string) => ({
      artifact_id: artifactId,
      content_sha256: contentSha256,
      locator: "l",
      retrieved_at: "2026-09-16T00:00:00Z",
    })

    await expect(resolver.resolve(ref(kept.artifactId, kept.contentSha256))).resolves.toEqual({
      ok: true,
    })
    await expect(resolver.resolve(ref(hidden.artifactId, hidden.contentSha256))).resolves.toEqual({
      ok: false,
      reason: "not_readable",
    })
    await expect(resolver.resolve(ref(kept.artifactId, hidden.contentSha256))).resolves.toEqual({
      ok: false,
      reason: "hash_mismatch",
    })
    await expect(
      resolver.resolve(ref("00000000-0000-4000-8000-00000000ffff", kept.contentSha256))
    ).resolves.toEqual({
      ok: false,
      reason: "missing",
    })
  })

  it("reads everything when no rule narrows it", async () => {
    const store = new MemoryArtifactStore()
    const stored = await store.put("x", "text/plain", "anywhere")
    await expect(
      new MemoryEvidenceResolver(store).resolve({
        artifact_id: stored.artifactId,
        content_sha256: stored.contentSha256,
        locator: "l",
        retrieved_at: "2026-09-16T00:00:00Z",
      })
    ).resolves.toEqual({ ok: true })
  })
})
