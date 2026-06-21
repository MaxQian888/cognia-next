/**
 * Coverage for `persistChunks` — the double-write step that lands chunks
 * in Dexie + the remote vector store. The re-parse path (`M1`) added an
 * idempotent "delete-existing-first" step so re-ingesting the same
 * source converges to one set of chunks instead of accumulating.
 */

import "fake-indexeddb/auto"
import { persistChunks } from "./persist"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createTwinChunk, listTwinChunksBySource } from "@/lib/db/twin-chunks"
import { createTwinSource } from "@/lib/db/twin-sources"
import type { IVectorStore } from "@cognia/vector/store"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function fakeStore(): IVectorStore & {
  addedIds: string[]
  deletedIds: string[]
  collections: Set<string>
} {
  const addedIds: string[] = []
  const deletedIds: string[] = []
  const collections = new Set<string>()
  return {
    addedIds,
    deletedIds,
    collections,
    async createCollection(name: string) {
      collections.add(name)
    },
    async addDocuments(_collection: string, docs: Array<{ id: string }>) {
      addedIds.push(...docs.map((d) => d.id))
    },
    async deleteDocuments(_collection: string, ids: string[]) {
      deletedIds.push(...ids)
    },
    async searchByEmbedding() {
      return []
    },
    async deleteCollection(name: string) {
      collections.delete(name)
    },
    async listCollections() {
      return Array.from(collections).map((c) => ({ name: c }))
    },
  } as unknown as IVectorStore & {
    addedIds: string[]
    deletedIds: string[]
    collections: Set<string>
  }
}

async function makeSource(twinId: string, sourceId: string): Promise<void> {
  await createTwinSource({
    id: sourceId,
    twinId,
    kind: "document",
    format: "markdown",
    source: "raw",
    title: "doc",
    bytes: 1,
    fingerprint: "fp",
    redacted: false,
  })
}

describe("persistChunks", () => {
  it("writes chunks to both Dexie and the vector store", async () => {
    const store = fakeStore()
    await makeSource("twin_a", "src_a")
    const result = await persistChunks({
      twinId: "twin_a",
      sourceId: "src_a",
      vectorBackend: "qdrant",
      store,
      chunks: [
        {
          content: "Hi",
          contentRedacted: "Hi",
          charStart: 0,
          charEnd: 2,
          strategy: "paragraph",
          tokenCount: 1,
          metadata: {},
        },
        {
          content: "Bye",
          contentRedacted: "Bye",
          charStart: 3,
          charEnd: 6,
          strategy: "paragraph",
          tokenCount: 1,
          metadata: {},
        },
      ],
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    })
    expect(result.rows).toHaveLength(2)
    expect(store.addedIds).toHaveLength(2)
    const persisted = await listTwinChunksBySource("src_a")
    expect(persisted).toHaveLength(2)
  })

  it("idempotently replaces chunks on re-parse + drops remote vectors", async () => {
    const store = fakeStore()
    await makeSource("twin_b", "src_b")
    // Seed an existing chunk to simulate a prior ingest.
    await createTwinChunk({
      twinId: "twin_b",
      sourceId: "src_b",
      content: "old",
      contentRedacted: "old",
      charStart: 0,
      charEnd: 3,
      vectorBackend: "qdrant",
      vectorCollection: "cognia_twin_twin_b",
      vectorDocId: "old-vector-1",
      strategy: "paragraph",
      tokenCount: 1,
      metadata: {},
    })
    await persistChunks({
      twinId: "twin_b",
      sourceId: "src_b",
      vectorBackend: "qdrant",
      store,
      chunks: [
        {
          content: "new",
          contentRedacted: "new",
          charStart: 0,
          charEnd: 3,
          strategy: "paragraph",
          tokenCount: 1,
          metadata: {},
        },
      ],
      embeddings: [[0.9, 0.8]],
    })
    // The pre-existing remote vector should have been deleted before the
    // new one was added.
    expect(store.deletedIds).toEqual(["old-vector-1"])
    // Dexie now has exactly one fresh row, not the stale + new.
    const persisted = await listTwinChunksBySource("src_b")
    expect(persisted).toHaveLength(1)
    expect(persisted[0].content).toBe("new")
  })

  it("tolerates a remote backend that doesn't implement deleteDocuments", async () => {
    const store = fakeStore()
    // Override delete to throw.
    store.deleteDocuments = async () => {
      throw new Error("not implemented")
    }
    await makeSource("twin_c", "src_c")
    await createTwinChunk({
      twinId: "twin_c",
      sourceId: "src_c",
      content: "old",
      contentRedacted: "old",
      charStart: 0,
      charEnd: 3,
      vectorBackend: "qdrant",
      vectorCollection: "cognia_twin_twin_c",
      vectorDocId: "old-vector-1",
      strategy: "paragraph",
      tokenCount: 1,
      metadata: {},
    })
    await persistChunks({
      twinId: "twin_c",
      sourceId: "src_c",
      vectorBackend: "qdrant",
      store,
      chunks: [
        {
          content: "new",
          contentRedacted: "new",
          charStart: 0,
          charEnd: 3,
          strategy: "paragraph",
          tokenCount: 1,
          metadata: {},
        },
      ],
      embeddings: [[0.9, 0.8]],
    })
    // Dexie still ends up with the new row only — local consistency wins
    // even if the remote delete failed.
    const persisted = await listTwinChunksBySource("src_c")
    expect(persisted).toHaveLength(1)
    expect(persisted[0].content).toBe("new")
  })
})
