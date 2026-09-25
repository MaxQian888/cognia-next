import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { setDraftDebounced, clearDraft } from "@/lib/db/chat-drafts"
import { loggers } from "@cognia/logging"
import { putSessionAsset, listSessionAssets } from "@/lib/db/session-assets"
import { clearBrowserPreviewData } from "@/lib/browser/preview-data"
import { clearTables, clearAll } from "./clear"

jest.mock("@/lib/browser/preview-data", () => ({ clearBrowserPreviewData: jest.fn() }))
const clearPreview = clearBrowserPreviewData as jest.Mock

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

const ownedTables = [
  "sessions",
  "messages",
  "sessionState",
  "chatDrafts",
  "chatInputHistory",
  "messageMediaRefs",
  "chatTurnSummaries",
  "chatTranscriptIndexState",
]

async function seedSessions() {
  const db = getDb()
  for (const sessionId of ["a", "b"]) {
    await db.sessions.put({
      id: sessionId,
      projectId: "p",
      title: sessionId,
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    })
    await db.messages.put({
      id: sessionId,
      sessionId,
      role: "user",
      parts: [],
      createdAt: 1,
    } as never)
    await db.sessionState.put({ sessionId, lastReadAt: 1, unreadCount: 1 })
    await db.chatDrafts.put({ sessionId, text: "draft", updatedAt: 1 })
    await db.chatInputHistory.add({ sessionId, text: "sent", createdAt: 1 })
    await db.messageMediaRefs.put({ messageId: sessionId, sessionId, hash: "shared" })
    await db.chatTranscriptIndexState.put({
      sessionId,
      revision: 1,
      indexedBeforeCreatedAt: 1,
      complete: true,
      updatedAt: 1,
    })
    await db.chatTurnSummaries.put({
      sessionId,
      turnKey: "turn",
      itemKey: "turn",
      order: 1,
      revision: 1,
      detailRevision: 1,
      item: {
        kind: "completed-turn",
        itemKey: "turn",
        turnKey: "turn",
        revision: 1,
        detailRevision: 1,
        status: "completed",
        userMessages: [],
        startedAt: 1,
        collapsed: { exists: false, messageCount: 1, trailingCount: 0, mediaCount: 0 },
      },
      updatedAt: 1,
    })
  }
  for (const hash of ["shared", "unrelated-orphan"]) {
    await db.messageMedia.put({
      hash,
      mediaType: "image/png",
      width: 1,
      height: 1,
      blob: new Blob(["image"]),
      byteSize: 5,
      createdAt: 1,
      lastUsedAt: 1,
    })
  }
}

describe("clearTables", () => {
  it("returns immediately when given no names", async () => {
    const transaction = jest.spyOn(getDb(), "transaction")
    try {
      await clearTables([])
      expect(transaction).not.toHaveBeenCalled()
    } finally {
      transaction.mockRestore()
    }
  })

  it("clears session-owned rows and tombstones them, collecting only candidate media", async () => {
    await seedSessions()
    await clearTables(["sessions"])
    const db = getDb()
    for (const name of ownedTables) expect(await db.table(name).count()).toBe(0)
    expect((await db.messageMedia.toArray()).map((row) => row.hash)).toEqual(["unrelated-orphan"])
    for (const name of ["sessions", "messages", "sessionState"]) {
      expect(
        (await db.syncTombstones.where("table").equals(name).toArray()).map((row) => row.id).sort()
      ).toEqual(["a", "b"])
    }
  })

  it("clears requested settings tables while preserving unselected sessions and shared media", async () => {
    await seedSessions()
    const db = getDb()
    const names = [
      "characters",
      "skills",
      "teams",
      "promptPresets",
      "mcpServers",
      "settings",
    ] as const
    for (const name of names) await db.table(name).put({ id: "configured" })
    await clearTables([...names])
    for (const name of names) expect(await db.table(name).count()).toBe(0)
    expect(await db.sessions.count()).toBe(2)
    expect(await db.messageMediaRefs.count()).toBe(2)
    expect(await db.messageMedia.get("shared")).toBeDefined()
    expect(await db.syncTombstones.count()).toBe(0)
  })

  it("rolls back session cleanup and tombstones when another selected table fails", async () => {
    await seedSessions()
    const db = getDb()
    await db.characters.put({ id: "character" } as never)
    const failDelete = () => {
      throw new Error("character delete failed")
    }
    db.characters.hook("deleting", failDelete)
    try {
      await expect(clearTables(["sessions", "characters"])).rejects.toThrow(
        "character delete failed"
      )
    } finally {
      db.characters.hook("deleting").unsubscribe(failDelete)
    }
    for (const name of ownedTables) expect(await db.table(name).count()).toBe(2)
    expect(await db.characters.count()).toBe(1)
    expect(await db.syncTombstones.count()).toBe(0)
    expect(await db.messageMedia.count()).toBe(2)
  })

  it("preserves unselected settings tables", async () => {
    const db = getDb()
    await db.characters.put({ id: "character" } as never)
    await db.skills.put({ id: "skill" } as never)
    await clearTables(["characters"])
    expect(await db.characters.count()).toBe(0)
    expect(await db.skills.get("skill")).toBeDefined()
  })

  it("keeps reset committed when draft timer cleanup fails", async () => {
    await seedSessions()
    const db = getDb()
    const failDelete = jest
      .spyOn(db.chatDrafts, "delete")
      .mockRejectedValueOnce(new Error("closed"))
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
    try {
      await expect(clearTables(["sessions"])).resolves.toBeUndefined()
      expect(await db.sessions.count()).toBe(0)
      expect(await db.chatDrafts.count()).toBe(0)
      expect(warn).toHaveBeenCalledWith("cleared session draft cleanup failed", {
        sessionId: "a",
        error: "Error: closed",
      })
    } finally {
      failDelete.mockRestore()
      warn.mockRestore()
    }
  })

  it("keeps a committed reset successful when media collection fails", async () => {
    await seedSessions()
    const db = getDb()
    const failDelete = () => {
      throw new Error("media unavailable")
    }
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
    db.messageMedia.hook("deleting", failDelete)
    try {
      await expect(clearTables(["sessions"])).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith("cleared session media cleanup failed", {
        error: "Error: media unavailable",
      })
    } finally {
      db.messageMedia.hook("deleting").unsubscribe(failDelete)
      warn.mockRestore()
    }
    expect(await db.sessions.count()).toBe(0)
    expect(await db.messageMediaRefs.count()).toBe(0)
    expect(await db.messageMedia.get("shared")).toBeDefined()
  })

  it("cancels pending draft saves after reset", async () => {
    await seedSessions()
    const setTimer = jest.spyOn(globalThis, "setTimeout")
    setDraftDebounced("a", "must not return", [], 1000)
    const timer = setTimer.mock.results.at(-1)?.value
    setTimer.mockRestore()
    const clearTimer = jest.spyOn(globalThis, "clearTimeout")
    try {
      await clearTables(["sessions"])
      expect(clearTimer).toHaveBeenCalledWith(timer)
    } finally {
      clearTimer.mockRestore()
      await clearDraft("a", { hostAlreadyCleared: true })
    }
  })
})

describe("clearAll", () => {
  it("deletes the entire database", async () => {
    const db = getDb()
    const remove = jest.spyOn(db, "delete")
    try {
      await clearAll()
      expect(remove).toHaveBeenCalledTimes(1)
    } finally {
      remove.mockRestore()
    }
  })

  it("deletes the Router + Fusion ledger beside the database", async () => {
    const fusionName = `${getDb().name}-router-fusion-v1`
    const fusion = new Dexie(fusionName)
    fusion.version(1).stores({ fusionRuns: "&runId" })
    await fusion.open()
    await fusion.table("fusionRuns").put({ runId: "run-1" })
    fusion.close()

    await clearAll()

    expect(await Dexie.exists(fusionName)).toBe(false)
  })

  // The preview's cookies and preferences live outside the database; a reset
  // device must not stay signed in to the sites the preview visited.
  it("signs the built-in browser out and forgets its preferences", async () => {
    clearPreview.mockReset().mockResolvedValue({ cookiesRemoved: 2 })
    await clearAll()
    expect(clearPreview).toHaveBeenCalledTimes(1)
  })

  it("still clears the database when the browser's cookie store is unreachable", async () => {
    clearPreview.mockReset().mockRejectedValue(new Error("no webview"))
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => undefined)
    const remove = jest.spyOn(getDb(), "delete")
    try {
      await expect(clearAll()).resolves.toBeUndefined()
      expect(remove).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalled()
    } finally {
      remove.mockRestore()
      warn.mockRestore()
    }
  })
})

it("clears durable and temporary attachment ownership with sessions", async () => {
  await seedSessions()
  await putSessionAsset({
    sessionId: "a",
    assetId: "durable",
    filename: "source",
    mediaType: "text/plain",
    blob: new Blob(["retained"]),
  })
  await putSessionAsset({
    sessionId: "a",
    assetId: "temporary",
    filename: "source",
    mediaType: "text/plain",
    blob: new Blob(["ephemeral"]),
    temporary: true,
  })
  await clearTables(["sessions"])
  expect(await listSessionAssets("a")).toEqual([])
  expect(await getDb().messageMedia.where("hash").startsWith("original:").count()).toBe(0)
})
