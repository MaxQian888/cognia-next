import { MemoryArtifactStore } from "../fake/memory-artifacts"
import { MemoryEvidenceResolver } from "../fake/memory-evidence"
import { checkEvidenceRefs } from "./evidence"

const RETRIEVED = "2026-09-16T08:00:00Z"

async function seeded() {
  const store = new MemoryArtifactStore()
  const page = await store.put("the tariff rose 4% in 2025", "text/plain", "runs/run-1/evidence")
  const foreign = await store.put("another tenant's notes", "text/plain", "runs/run-9/evidence")
  const resolver = new MemoryEvidenceResolver(store, (_id, namespace) =>
    namespace.startsWith("runs/run-1/")
  )
  return { store, page, foreign, resolver }
}

describe("checkEvidenceRefs", () => {
  it("keeps a reference that exists, is readable and still hashes to what it pinned", async () => {
    const { page, resolver } = await seeded()
    const ref = {
      artifact_id: page.artifactId,
      content_sha256: page.contentSha256,
      locator: "https://example.com/tariffs#p2",
      retrieved_at: RETRIEVED,
    }
    await expect(checkEvidenceRefs([ref], resolver)).resolves.toEqual({
      valid: [ref],
      rejected: [],
    })
  })

  it("rejects an invented, a foreign, a stale and a malformed reference, each with its reason", async () => {
    const { page, foreign, resolver } = await seeded()
    const invented = {
      artifact_id: "99999999-9999-4999-8999-999999999999",
      content_sha256: page.contentSha256,
      locator: "made up",
      retrieved_at: RETRIEVED,
    }
    const other = {
      artifact_id: foreign.artifactId,
      content_sha256: foreign.contentSha256,
      locator: "notes",
      retrieved_at: RETRIEVED,
    }
    const stale = {
      artifact_id: page.artifactId,
      content_sha256: "0".repeat(64),
      locator: "same url, other content",
      retrieved_at: RETRIEVED,
    }
    const malformed = { artifact_id: "not-a-uuid", locator: "x" }

    const verdict = await checkEvidenceRefs([invented, other, stale, malformed], resolver)

    expect(verdict.valid).toEqual([])
    expect(verdict.rejected.map((entry) => entry.reason)).toEqual([
      "missing",
      "not_readable",
      "hash_mismatch",
      "malformed",
    ])
  })

  it("counts one piece of evidence once, however often a claim repeats it", async () => {
    const { page, resolver } = await seeded()
    const ref = {
      artifact_id: page.artifactId,
      content_sha256: page.contentSha256,
      locator: "p2",
      retrieved_at: RETRIEVED,
    }
    const verdict = await checkEvidenceRefs([ref, { ...ref }, ref], resolver)
    expect(verdict.valid).toHaveLength(1)
  })

  it("asks the resolver nothing about a reference that is not even well formed", async () => {
    const resolver = { resolve: jest.fn() }
    await checkEvidenceRefs([null, 42, { artifact_id: 1 }], resolver)
    expect(resolver.resolve).not.toHaveBeenCalled()
  })
})
