import { createInMemoryMediaJobStore } from "./store"
import type { MediaGenerationJobRow } from "./types"

function row(id: string, overrides: Partial<MediaGenerationJobRow> = {}): MediaGenerationJobRow {
  return {
    id,
    kind: "video",
    origin: { surface: "executor" },
    request: { prompt: "p" },
    provider: { providerId: "google", modelId: "veo", credentialAffinity: "keyless" },
    operation: { operationName: id },
    status: "generating",
    pollCount: 0,
    nextPollAt: 100,
    deadlineAt: 1000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("in-memory media job store", () => {
  it("guards transitions on the current status", async () => {
    const store = createInMemoryMediaJobStore()
    await store.insert(row("a"))
    await expect(store.transition("a", "generating", "downloading")).resolves.toMatchObject({
      status: "downloading",
    })
    await expect(store.transition("a", "generating", "downloading")).resolves.toBeUndefined()
    await expect(store.update("a", "generating", { pollCount: 3 })).resolves.toBeUndefined()
    await expect(store.update("a", "downloading", { pollCount: 3 })).resolves.toMatchObject({
      pollCount: 3,
    })
    await expect(store.insert(row("a"))).rejects.toThrow("already exists")
  })

  it("lists due jobs oldest first", async () => {
    const store = createInMemoryMediaJobStore()
    await store.insert(row("late", { nextPollAt: 300 }))
    await store.insert(row("early", { nextPollAt: 50 }))
    await store.insert(row("future", { nextPollAt: 5000 }))
    await store.insert(row("done", { status: "succeeded", nextPollAt: 0 }))
    expect((await store.listDue("generating", 400)).map((r) => r.id)).toEqual(["early", "late"])
    expect((await store.listByStatus("succeeded")).map((r) => r.id)).toEqual(["done"])
  })
})
