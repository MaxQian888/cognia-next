import { rebuildTwinIndex, removeTwin, removeTwinSource } from "./lifecycle"

function deps(overrides: Record<string, unknown> = {}) {
  const store = {
    deleteDocuments: jest.fn(async () => undefined),
    deleteCollection: jest.fn(async () => undefined),
  }
  return {
    store,
    value: {
      getSettings: jest.fn(async () => ({ workerEnabled: false })),
      buildAdapters: jest.fn(async () => ({
        ready: true as const,
        adapters: { store },
      })),
      getSource: jest.fn(async () => ({ id: "src-1" })),
      listSourceChunks: jest.fn(async () => [
        { vectorCollection: "c", vectorDocId: "v1" },
        { vectorCollection: "c", vectorDocId: "v2" },
      ]),
      deleteSourceRows: jest.fn(async () => undefined),
      getTwin: jest.fn(async () => ({ id: "twin-1" })),
      listTwinChunks: jest.fn(async () => [{ vectorCollection: "custom" }]),
      listActiveJobs: jest.fn(async () => [{ id: "job-1" }]),
      cancelJob: jest.fn(async () => undefined),
      syncCron: jest.fn(async () => undefined),
      invalidateMemories: jest.fn(async () => 0),
      deleteTwinRows: jest.fn(async () => ({ sources: 1 })),
      ...overrides,
    },
  }
}

it("deletes source vectors before canonical rows", async () => {
  const d = deps()
  const result = await removeTwinSource("src-1", d.value as never)

  expect(result).toEqual({ ok: true, removed: true })
  expect(d.store.deleteDocuments).toHaveBeenCalledWith("c", ["v1", "v2"])
  expect(d.store.deleteDocuments.mock.invocationCallOrder[0]).toBeLessThan(
    d.value.deleteSourceRows.mock.invocationCallOrder[0]
  )
})

it("keeps local source rows when vector cleanup fails", async () => {
  const d = deps()
  d.store.deleteDocuments.mockRejectedValueOnce(new Error("offline"))

  await expect(removeTwinSource("src-1", d.value as never)).resolves.toMatchObject({
    ok: false,
    removed: false,
    stage: "vector-store",
  })
  expect(d.value.deleteSourceRows).not.toHaveBeenCalled()
})

it("treats an already-missing source as an idempotent no-op", async () => {
  const d = deps({ getSource: jest.fn(async () => undefined) })

  await expect(removeTwinSource("missing", d.value as never)).resolves.toEqual({
    ok: true,
    removed: false,
  })
  expect(d.value.deleteSourceRows).not.toHaveBeenCalled()
})

it("retains a source when its vector adapter is unavailable", async () => {
  const d = deps({
    buildAdapters: jest.fn(async () => ({ ready: false as const, reason: "incomplete-storage" })),
  })

  await expect(removeTwinSource("src-1", d.value as never)).resolves.toMatchObject({
    ok: false,
    removed: false,
    stage: "runtime-adapter",
  })
  expect(d.value.deleteSourceRows).not.toHaveBeenCalled()
})

it("stops jobs and cron, removes collections, then deletes Twin rows", async () => {
  const d = deps()
  const result = await removeTwin("twin-1", d.value as never)

  expect(result).toMatchObject({ ok: true, removed: true, value: { sources: 1 } })
  expect(d.value.cancelJob).toHaveBeenCalledWith("job-1", "twin deleted")
  expect(d.value.syncCron).toHaveBeenCalledWith("twin-1", undefined)
  expect(d.store.deleteCollection).toHaveBeenCalledWith("custom")
  expect(d.store.deleteCollection).toHaveBeenCalledWith("cognia_twin_twin-1")
  expect(d.value.invalidateMemories).toHaveBeenCalledWith("twin-1")
  expect(d.value.deleteTwinRows).toHaveBeenCalledWith("twin-1", {
    skipExternalCleanup: true,
  })
})

it("retains Twin rows when memory invalidation fails", async () => {
  const d = deps({ invalidateMemories: jest.fn(async () => Promise.reject(new Error("locked"))) })

  await expect(removeTwin("twin-1", d.value as never)).resolves.toMatchObject({
    ok: false,
    removed: false,
    stage: "memory",
    error: "locked",
  })
  expect(d.value.deleteTwinRows).not.toHaveBeenCalled()
})

describe("rebuildTwinIndex", () => {
  const embedding = { provider: "cohere", model: "embed-english-v3.0", apiKey: "k" }
  function rebuildDeps(overrides: Record<string, unknown> = {}) {
    const built = deps({
      getSettings: jest.fn(async () => ({
        workerEnabled: true,
        embedding: { provider: "openai", model: "m", apiKey: "g" },
      })),
      listActiveJobs: jest.fn(async () => [
        { id: "ingest-1", kind: "ingest" },
        { id: "distill-1", kind: "distill" },
      ]),
      resolveEmbeddingPlan: jest.fn(async () => ({
        config: embedding,
        source: "twin",
        credentialsReady: true,
      })),
      resetIndexRows: jest.fn(async () => ({
        chunks: 4,
        sourceIds: ["s1", "s2"],
        styleEmbeddingsCleared: 1,
      })),
      enqueueIngest: jest.fn(async () => ({ id: "job-rebuild" })),
      ...overrides,
    })
    return {
      ...built,
      value: built.value as typeof built.value & {
        resolveEmbeddingPlan: jest.Mock
        resetIndexRows: jest.Mock
        enqueueIngest: jest.Mock
      },
    }
  }

  it("drops the collections, resets rows, then queues one re-ingest job", async () => {
    const d = rebuildDeps()
    const result = await rebuildTwinIndex("twin-1", d.value as never)

    expect(result).toEqual({
      ok: true,
      rebuilt: true,
      value: {
        jobId: "job-rebuild",
        sourceIds: ["s1", "s2"],
        droppedCollections: ["cognia_twin_twin-1", "custom"],
        cancelledJobIds: ["ingest-1"],
        chunksRemoved: 4,
        embedding: { provider: "cohere", model: "embed-english-v3.0", source: "twin" },
      },
    })
    // Adapters must be built with the worker requirement (no `requireEnabled: false`).
    expect(d.value.buildAdapters).toHaveBeenCalledWith(
      expect.objectContaining({ workerEnabled: true })
    )
    expect(d.value.cancelJob).toHaveBeenCalledWith("ingest-1", "twin index rebuild")
    expect(d.value.cancelJob).not.toHaveBeenCalledWith("distill-1", expect.anything())
    expect(d.store.deleteCollection.mock.invocationCallOrder[0]).toBeLessThan(
      d.value.resetIndexRows.mock.invocationCallOrder[0]
    )
    expect(d.value.enqueueIngest).toHaveBeenCalledWith({
      twinId: "twin-1",
      sourceIds: ["s1", "s2"],
    })
  })

  it("does not queue a job when the twin has no live sources", async () => {
    const d = rebuildDeps({
      resetIndexRows: jest.fn(async () => ({
        chunks: 0,
        sourceIds: [],
        styleEmbeddingsCleared: 0,
      })),
    })
    const result = await rebuildTwinIndex("twin-1", d.value as never)
    expect(result).toMatchObject({ ok: true, rebuilt: true })
    expect(result.ok && result.value?.jobId).toBeFalsy()
    expect(d.value.enqueueIngest).not.toHaveBeenCalled()
  })

  it("destroys nothing when the effective embedding has no credentials", async () => {
    const d = rebuildDeps({
      resolveEmbeddingPlan: jest.fn(async () => ({
        config: embedding,
        source: "twin",
        credentialsReady: false,
      })),
    })
    await expect(rebuildTwinIndex("twin-1", d.value as never)).resolves.toEqual({
      ok: false,
      rebuilt: false,
      stage: "embedding",
      error: "twin-embedding-unconfigured: cohere",
    })
    expect(d.store.deleteCollection).not.toHaveBeenCalled()
    expect(d.value.resetIndexRows).not.toHaveBeenCalled()
  })

  it("destroys nothing when the runtime adapter is not ready", async () => {
    const d = rebuildDeps({
      buildAdapters: jest.fn(async () => ({ ready: false as const, reason: "disabled" })),
    })
    await expect(rebuildTwinIndex("twin-1", d.value as never)).resolves.toMatchObject({
      ok: false,
      stage: "runtime-adapter",
      error: "disabled",
    })
    expect(d.value.cancelJob).not.toHaveBeenCalled()
    expect(d.store.deleteCollection).not.toHaveBeenCalled()
  })

  it("keeps local rows when a collection cannot be dropped", async () => {
    const d = rebuildDeps()
    d.store.deleteCollection.mockRejectedValueOnce(new Error("offline"))
    await expect(rebuildTwinIndex("twin-1", d.value as never)).resolves.toMatchObject({
      ok: false,
      stage: "vector-store",
      error: "offline",
    })
    expect(d.value.resetIndexRows).not.toHaveBeenCalled()
  })

  it("reports a missing twin as a no-op", async () => {
    const d = rebuildDeps({ getTwin: jest.fn(async () => undefined) })
    await expect(rebuildTwinIndex("gone", d.value as never)).resolves.toEqual({
      ok: true,
      rebuilt: false,
    })
    expect(d.value.getSettings).not.toHaveBeenCalled()
  })

  it("surfaces a failed enqueue as a database-stage failure", async () => {
    const d = rebuildDeps({
      enqueueIngest: jest.fn(async () => Promise.reject(new Error("quota"))),
    })
    await expect(rebuildTwinIndex("twin-1", d.value as never)).resolves.toMatchObject({
      ok: false,
      stage: "database",
      error: "quota",
    })
  })
})
