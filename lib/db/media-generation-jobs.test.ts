/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import type { MediaGenerationJobRow } from "@/lib/ai/media/video-jobs/types"
import { getDb } from "./schema"
import {
  createDexieMediaJobStore,
  listSessionVideoJobs,
  pruneSettledVideoJobs,
} from "./media-generation-jobs"

function row(id: string, overrides: Partial<MediaGenerationJobRow> = {}): MediaGenerationJobRow {
  return {
    id,
    kind: "video",
    sessionId: "s1",
    origin: { surface: "chat-tool", sessionId: "s1" },
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

beforeEach(async () => {
  await getDb().mediaGenerationJobs.clear()
})

describe("Dexie media job store", () => {
  it("transitions only from the expected status, so one window wins a download", async () => {
    const store = createDexieMediaJobStore()
    await store.insert(row("a"))
    const [first, second] = await Promise.all([
      store.transition("a", "generating", "downloading"),
      store.transition("a", "generating", "downloading"),
    ])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect((await store.get("a"))?.status).toBe("downloading")
  })

  it("clears a field patched to undefined", async () => {
    const store = createDexieMediaJobStore()
    await store.insert(row("a", { lastPollError: "boom" }))
    await store.update("a", "generating", { lastPollError: undefined })
    expect(await store.get("a")).not.toHaveProperty("lastPollError")
  })

  it("lists due jobs of one status by next poll time", async () => {
    const store = createDexieMediaJobStore()
    await store.insert(row("due", { nextPollAt: 50 }))
    await store.insert(row("later", { nextPollAt: 500 }))
    await store.insert(row("other", { status: "downloading", nextPollAt: 10 }))
    expect((await store.listDue("generating", 100)).map((r) => r.id)).toEqual(["due"])
    expect((await store.listByStatus("downloading")).map((r) => r.id)).toEqual(["other"])
  })

  it("lists a session's jobs newest first", async () => {
    const store = createDexieMediaJobStore()
    await store.insert(row("old", { createdAt: 1 }))
    await store.insert(row("new", { createdAt: 2 }))
    await store.insert(row("elsewhere", { sessionId: "s2", createdAt: 3 }))
    expect((await listSessionVideoJobs("s1")).map((r) => r.id)).toEqual(["new", "old"])
  })

  it("prunes old failed, cancelled and timed-out jobs but keeps succeeded ones", async () => {
    const store = createDexieMediaJobStore()
    await store.insert(row("failed", { status: "failed", settledAt: 10 }))
    await store.insert(row("cancelled", { status: "cancelled", settledAt: 10 }))
    await store.insert(row("timed", { status: "timed_out", settledAt: 10 }))
    await store.insert(row("ok", { status: "succeeded", settledAt: 10 }))
    await store.insert(row("recent", { status: "failed", settledAt: 1000 }))
    await store.insert(row("running"))
    await expect(pruneSettledVideoJobs(500)).resolves.toBe(3)
    expect((await getDb().mediaGenerationJobs.toCollection().primaryKeys()).sort()).toEqual([
      "ok",
      "recent",
      "running",
    ])
  })
})

describe("video job portability", () => {
  it("exports only settled jobs, scoped like the video they point at", async () => {
    const { isPortableVideoJob } = await import("./media-generation-jobs")
    const scope = { includeCoreData: false, exportedSessionIds: new Set(["s1"]) }
    expect(isPortableVideoJob(row("a", { status: "succeeded" }), scope)).toBe(true)
    expect(isPortableVideoJob(row("b"), scope)).toBe(false)
    expect(isPortableVideoJob(row("c", { status: "succeeded", sessionId: "s2" }), scope)).toBe(
      false
    )
    const plugin = row("d", {
      status: "succeeded",
      sessionId: undefined,
      origin: { surface: "plugin", pluginId: "p" },
    })
    expect(isPortableVideoJob(plugin, scope)).toBe(false)
    expect(isPortableVideoJob(plugin, { ...scope, includeCoreData: true })).toBe(true)
  })

  it("remaps a restored job onto its duplicated session", async () => {
    const { remapVideoJobSession } = await import("./media-generation-jobs")
    const restored = remapVideoJobSession(
      row("a", {
        status: "succeeded",
        result: {
          content: { kind: "session-asset", sessionId: "s1", assetId: "x" },
          mediaType: "video/mp4",
          byteSize: 1,
        },
      }),
      new Map([["s1", "s9"]])
    )
    expect(restored.sessionId).toBe("s9")
    expect(restored.origin).toEqual({ surface: "chat-tool", sessionId: "s9" })
    expect(restored.result?.content).toEqual({
      kind: "session-asset",
      sessionId: "s9",
      assetId: "x",
    })
    const untouched = row("b")
    expect(remapVideoJobSession(untouched, new Map())).toBe(untouched)
  })
})
