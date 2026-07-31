/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { createTwinChunk } from "./twin-chunks"
import {
  createTwinSource,
  deleteTwinSource,
  getTwinSource,
  listTwinSourcesByTwin,
} from "./twin-sources"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("twin source persistence", () => {
  it("creates, lists, and cascade-deletes a source with its chunks", async () => {
    const source = await createTwinSource({
      id: "source_a",
      twinId: "twin_a",
      kind: "document",
      format: "markdown",
      source: "/notes.md",
      title: "Notes",
      bytes: 42,
      fingerprint: "fingerprint-a",
      redacted: false,
    })
    await createTwinChunk({
      id: "chunk_a",
      twinId: source.twinId,
      sourceId: source.id,
      vectorDocId: "vector_a",
      content: "durable source content",
      contentRedacted: "durable source content",
      charStart: 0,
      charEnd: 22,
      vectorBackend: "qdrant",
      vectorCollection: "cognia_twin_a",
      strategy: "paragraph",
      tokenCount: 3,
      metadata: {},
      createdAt: 1,
    })

    expect(await getTwinSource(source.id)).toMatchObject({ status: "pending", chunkCount: 0 })
    expect((await listTwinSourcesByTwin(source.twinId)).map((row) => row.id)).toEqual([source.id])

    await deleteTwinSource(source.id)

    expect(await getTwinSource(source.id)).toBeUndefined()
    expect(await getDb().twinChunks.where("sourceId").equals(source.id).count()).toBe(0)
  })

  it("deletes a source that has no chunks without prematurely committing", async () => {
    const source = await createTwinSource({
      id: "source_empty",
      twinId: "twin_a",
      kind: "document",
      format: "text",
      source: "/empty.txt",
      title: "Empty",
      bytes: 0,
      fingerprint: "fingerprint-empty",
      redacted: false,
    })

    await deleteTwinSource(source.id)

    expect(await getTwinSource(source.id)).toBeUndefined()
  })
})
