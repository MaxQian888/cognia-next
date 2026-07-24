/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "./schema"
import {
  ensureChatSurface,
  getChatSurface,
  listDueChatSurfaces,
  markChatSurfaceBlocked,
  markChatSurfaceError,
  markChatSurfaceSynced,
  setChatSurfaceStatus,
} from "./lark-chat-surfaces"

const T0 = 1_753_000_000_000

describe("lark-chat-surfaces", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("is idempotent per (adapter, chat, surfaceType)", async () => {
    await ensureChatSurface({
      adapterId: "lk-1",
      chatId: "oc_1",
      surfaceType: "chat_tab",
      urlVersion: 1,
      desiredUrl: "https://x/lark/entry?surface=a",
      now: T0,
    })
    await ensureChatSurface({
      adapterId: "lk-1",
      chatId: "oc_1",
      surfaceType: "chat_tab",
      urlVersion: 1,
      desiredUrl: "https://x/lark/entry?surface=a",
      now: T0 + 1,
    })
    expect(await getDb().larkChatSurfaces.count()).toBe(1)
    // Different surface type on the same chat is its own row.
    await ensureChatSurface({
      adapterId: "lk-1",
      chatId: "oc_1",
      surfaceType: "group_menu",
      urlVersion: 1,
      now: T0,
    })
    expect(await getDb().larkChatSurfaces.count()).toBe(2)
  })

  it("re-arms a synced row when urlVersion changes", async () => {
    await ensureChatSurface({
      adapterId: "lk-1",
      chatId: "oc_1",
      surfaceType: "chat_tab",
      urlVersion: 1,
      desiredUrl: "u1",
      now: T0,
    })
    await markChatSurfaceSynced("lk-1", "oc_1", "chat_tab", {
      platformSurfaceId: "tab_9",
      now: T0 + 10,
    })
    expect((await getChatSurface("lk-1", "oc_1", "chat_tab"))?.status).toBe("synced")

    // Same version + URL → stays synced.
    await ensureChatSurface({
      adapterId: "lk-1",
      chatId: "oc_1",
      surfaceType: "chat_tab",
      urlVersion: 1,
      desiredUrl: "u1",
      now: T0 + 20,
    })
    expect((await getChatSurface("lk-1", "oc_1", "chat_tab"))?.status).toBe("synced")

    // Version bump → pending again, platform id retained for in-place update.
    await ensureChatSurface({
      adapterId: "lk-1",
      chatId: "oc_1",
      surfaceType: "chat_tab",
      urlVersion: 2,
      desiredUrl: "u2",
      now: T0 + 30,
    })
    const row = await getChatSurface("lk-1", "oc_1", "chat_tab")
    expect(row?.status).toBe("pending")
    expect(row?.platformSurfaceId).toBe("tab_9")
  })

  it("applies exponential backoff on errors and lists due rows accordingly", async () => {
    await ensureChatSurface({
      adapterId: "lk-1",
      chatId: "oc_1",
      surfaceType: "chat_tab",
      urlVersion: 1,
      now: T0,
    })
    const first = await markChatSurfaceError("lk-1", "oc_1", "chat_tab", "scope_missing", T0)
    expect(first?.attempt).toBe(1)
    expect(first?.nextAttemptAt).toBe(T0 + 30_000)
    const second = await markChatSurfaceError("lk-1", "oc_1", "chat_tab", "scope_missing", T0)
    expect(second?.attempt).toBe(2)
    expect(second?.nextAttemptAt).toBe(T0 + 60_000)

    // Not due while the backoff window is open…
    expect(await listDueChatSurfaces("lk-1", T0 + 30_000)).toHaveLength(0)
    // …due after it elapses.
    expect(await listDueChatSurfaces("lk-1", T0 + 61_000)).toHaveLength(1)
  })

  it("treats stale synced rows as due and removed rows as never due", async () => {
    await ensureChatSurface({
      adapterId: "lk-1",
      chatId: "oc_1",
      surfaceType: "chat_tab",
      urlVersion: 1,
      now: T0,
    })
    await markChatSurfaceSynced("lk-1", "oc_1", "chat_tab", { now: T0 })
    expect(await listDueChatSurfaces("lk-1", T0 + 60_000)).toHaveLength(0)
    expect(await listDueChatSurfaces("lk-1", T0 + 25 * 60 * 60 * 1000)).toHaveLength(1)

    await setChatSurfaceStatus("lk-1", "oc_1", "chat_tab", "removed", T0)
    expect(await listDueChatSurfaces("lk-1", T0 + 48 * 60 * 60 * 1000)).toHaveLength(0)
  })
})

describe("default clock arms", () => {
  it("ensure/synced/error/status/listDue work without an explicit now", async () => {
    const row = await ensureChatSurface({
      adapterId: "lk-now",
      chatId: "oc_now",
      surfaceType: "chat_tab",
      urlVersion: 1,
    })
    expect(row.status).toBe("pending")
    await markChatSurfaceSynced("lk-now", "oc_now", "chat_tab")
    await markChatSurfaceError("lk-now", "oc_now", "chat_tab", "boom")
    await setChatSurfaceStatus("lk-now", "oc_now", "chat_tab", "pending")
    const due = await listDueChatSurfaces("lk-now")
    expect(due.map((r) => r.chatId)).toContain("oc_now")
    // Missing-row guards on the same default arms.
    await markChatSurfaceSynced("lk-now", "oc_missing", "chat_tab")
    expect(await markChatSurfaceError("lk-now", "oc_missing", "chat_tab", "x")).toBeUndefined()
    await setChatSurfaceStatus("lk-now", "oc_missing", "chat_tab", "pending")
  })

  describe("blocked (terminal until reconfigured)", () => {
    it("parks with no nextAttemptAt and is never due", async () => {
      await ensureChatSurface({
        adapterId: "lk-1",
        chatId: "oc_1",
        surfaceType: "chat_tab",
        urlVersion: 1,
        desiredUrl: "https://a/x",
      })
      const row = await markChatSurfaceBlocked("lk-1", "oc_1", "chat_tab", "missing scope")

      expect(row?.status).toBe("blocked")
      expect(row?.nextAttemptAt).toBeUndefined()
      expect(row?.lastError).toBe("missing scope")
      expect(await listDueChatSurfaces("lk-1")).toHaveLength(0)
    })

    it("stays blocked when the desired target has not changed", async () => {
      const input = {
        adapterId: "lk-1",
        chatId: "oc_1",
        surfaceType: "chat_tab" as const,
        urlVersion: 1,
        desiredUrl: "https://a/x",
      }
      await ensureChatSurface(input)
      await markChatSurfaceBlocked("lk-1", "oc_1", "chat_tab", "missing scope")

      await ensureChatSurface(input)
      expect((await getChatSurface("lk-1", "oc_1", "chat_tab"))?.status).toBe("blocked")
    })

    it("re-arms when the url version or desired url changes", async () => {
      const base = {
        adapterId: "lk-1",
        chatId: "oc_1",
        surfaceType: "chat_tab" as const,
        urlVersion: 1,
        desiredUrl: "https://a/x",
      }
      await ensureChatSurface(base)
      await markChatSurfaceBlocked("lk-1", "oc_1", "chat_tab", "missing scope")

      await ensureChatSurface({ ...base, urlVersion: 2 })
      expect((await getChatSurface("lk-1", "oc_1", "chat_tab"))?.status).toBe("pending")

      await markChatSurfaceBlocked("lk-1", "oc_1", "chat_tab", "missing scope")
      await ensureChatSurface({ ...base, urlVersion: 2, desiredUrl: "https://a/y" })
      expect((await getChatSurface("lk-1", "oc_1", "chat_tab"))?.status).toBe("pending")
    })

    it("is cleared by an explicit status reset (the settings resync path)", async () => {
      await ensureChatSurface({
        adapterId: "lk-1",
        chatId: "oc_1",
        surfaceType: "chat_tab",
        urlVersion: 1,
      })
      await markChatSurfaceBlocked("lk-1", "oc_1", "chat_tab", "missing scope")

      await setChatSurfaceStatus("lk-1", "oc_1", "chat_tab", "pending")
      expect(await listDueChatSurfaces("lk-1")).toHaveLength(1)
    })

    it("returns undefined for an unknown surface", async () => {
      expect(await markChatSurfaceBlocked("lk-1", "oc_ghost", "chat_tab", "x")).toBeUndefined()
    })
  })
})
