import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import type { IVectorStore } from "@cognia/vector/store"
import { runGenerationSwap } from "./generation-ingest"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function store() {
  return {
    provider: "native",
    addDocuments: jest.fn(async () => undefined),
    deleteDocuments: jest.fn(async () => undefined),
  } as unknown as IVectorStore
}

describe("runGenerationSwap", () => {
  it("activates only after validation and reports deferred cleanup", async () => {
    const vectorStore = store()
    ;(vectorStore.deleteDocuments as jest.Mock).mockRejectedValueOnce(new Error("offline"))
    const result = await runGenerationSwap({
      idPrefix: "generation",
      corpusId: "project:1:file:1",
      domain: "project",
      profileFingerprint: "fingerprint",
      collection: "collection",
      store: vectorStore,
      contentHash: "hash",
      expectedCount: 1,
      expectedDimension: 2,
      oldVectors: [{ collection: "old-collection", id: "old-vector" }],
      build: (generationId) => ({
        value: generationId,
        count: 1,
        documents: [{ id: `${generationId}:0`, content: "safe", embedding: [1, 2] }],
      }),
      commit: async (_value, activate) => activate(),
    })

    expect(result.cleanupPending).toBe(true)
    expect(await getDb().retrievalActivePointers.get("project:1:file:1")).toMatchObject({
      generationId: result.generationId,
    })
  })

  it("fails staging and preserves the active pointer on dimension mismatch", async () => {
    const vectorStore = store()
    await expect(
      runGenerationSwap({
        idPrefix: "generation",
        corpusId: "kb:1:source:1",
        domain: "kb",
        profileFingerprint: "fingerprint",
        collection: "collection",
        store: vectorStore,
        contentHash: "hash",
        expectedCount: 1,
        expectedDimension: 2,
        oldVectors: [],
        build: (generationId) => ({
          value: generationId,
          count: 1,
          documents: [{ id: `${generationId}:0`, content: "safe", embedding: [1] }],
        }),
        commit: async () => {
          throw new Error("commit must not run")
        },
      })
    ).rejects.toThrow("validation")
    expect(await getDb().retrievalActivePointers.get("kb:1:source:1")).toBeUndefined()
    expect(await getDb().retrievalGenerations.where("status").equals("failed").count()).toBe(1)
  })
})
