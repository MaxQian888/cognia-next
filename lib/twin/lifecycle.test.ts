import { removeTwin, removeTwinSource } from "./lifecycle"

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
