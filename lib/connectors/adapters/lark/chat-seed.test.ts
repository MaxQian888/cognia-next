/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getChatSurface } from "@/lib/db/lark-chat-surfaces"
import { listBotChats, seedLarkChatSurfaces, type LarkChatListItem } from "./chat-seed"

const CREDS = { appId: "cli_1", appSecret: "s" }
const WHOAMI = { botName: "b", appId: "cli_1", openId: "ou_bot", tenantKey: "tk_a" }

function adapterRow(settings: Record<string, unknown>, whoami: unknown = WHOAMI) {
  return { id: "lk-1", settings, lastWhoamiResult: whoami } as never
}

/** One page per call, driven off `page_token`. */
function pagedRequest(pages: LarkChatListItem[][]) {
  const calls: string[] = []
  const request = jest.fn(async (_creds: unknown, _method: string, urlPath: string) => {
    calls.push(urlPath)
    const token = new URLSearchParams(urlPath.split("?")[1] ?? "").get("page_token")
    const index = token ? Number(token) : 0
    const hasMore = index + 1 < pages.length
    return {
      data: {
        items: pages[index] ?? [],
        has_more: hasMore,
        ...(hasMore ? { page_token: String(index + 1) } : {}),
      },
    }
  })
  return { request, calls }
}

function seedInput() {
  return { adapterId: "lk-1", resolveCreds: async () => CREDS }
}

describe("listBotChats", () => {
  it("pages until has_more is false", async () => {
    const { request, calls } = pagedRequest([
      [{ chat_id: "oc_1" }],
      [{ chat_id: "oc_2" }, { chat_id: "oc_3" }],
    ])
    const chats = await listBotChats(
      { request: request as never, getAdapter: jest.fn(), ensure: jest.fn(), now: () => 1 },
      CREDS
    )
    expect(chats.map((c) => c.chat_id)).toEqual(["oc_1", "oc_2", "oc_3"])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain("page_token=1")
  })

  it("stops on a response with no items", async () => {
    const { request } = pagedRequest([[]])
    const chats = await listBotChats(
      { request: request as never, getAdapter: jest.fn(), ensure: jest.fn(), now: () => 1 },
      CREDS
    )
    expect(chats).toEqual([])
  })
})

describe("seedLarkChatSurfaces", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("does nothing when both surface flags are off", async () => {
    const { request } = pagedRequest([[{ chat_id: "oc_1" }]])
    const result = await seedLarkChatSurfaces(seedInput(), {
      request: request as never,
      getAdapter: async () => adapterRow({ larkChatTab: false, larkGroupMenu: false }),
    })
    expect(result).toEqual({ chats: 0, seeded: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it("does not call the platform when the tenant identity is unknown", async () => {
    const { request } = pagedRequest([[{ chat_id: "oc_1" }]])
    const result = await seedLarkChatSurfaces(seedInput(), {
      request: request as never,
      getAdapter: async () =>
        adapterRow(
          { larkChatTab: true, larkGroupMenu: false },
          { botName: "b", appId: "cli_1", openId: "ou_bot" }
        ),
    })
    expect(result).toEqual({ chats: 0, seeded: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it("seeds a chat_tab row for every chat, carrying the tenant identity", async () => {
    const { request } = pagedRequest([[{ chat_id: "oc_1" }, { chat_id: "oc_2" }]])
    const result = await seedLarkChatSurfaces(seedInput(), {
      request: request as never,
      getAdapter: async () => adapterRow({ larkChatTab: true, larkGroupMenu: false }),
    })

    expect(result).toEqual({ chats: 2, seeded: 2 })
    const row = await getChatSurface("lk-1", "oc_1", "chat_tab")
    expect(row?.status).toBe("pending")
    expect(row?.tenantKey).toBe("tk_a")
    expect(row?.appId).toBe("cli_1")
    expect(await getChatSurface("lk-1", "oc_1", "group_menu")).toBeUndefined()
  })

  it("never seeds a group menu for a p2p chat", async () => {
    const { request } = pagedRequest([
      [
        { chat_id: "oc_group", chat_mode: "group" },
        { chat_id: "oc_p2p", chat_mode: "p2p" },
      ],
    ])
    const result = await seedLarkChatSurfaces(seedInput(), {
      request: request as never,
      getAdapter: async () => adapterRow({ larkChatTab: true, larkGroupMenu: true }),
    })

    // 2 tabs + 1 group menu.
    expect(result).toEqual({ chats: 2, seeded: 3 })
    expect(await getChatSurface("lk-1", "oc_group", "group_menu")).toBeDefined()
    expect(await getChatSurface("lk-1", "oc_p2p", "group_menu")).toBeUndefined()
    expect(await getChatSurface("lk-1", "oc_p2p", "chat_tab")).toBeDefined()
  })

  it("treats a chat with no chat_mode as a group (topic chats included)", async () => {
    const { request } = pagedRequest([[{ chat_id: "oc_1" }]])
    await seedLarkChatSurfaces(seedInput(), {
      request: request as never,
      getAdapter: async () => adapterRow({ larkGroupMenu: true, larkChatTab: false }),
    })
    expect(await getChatSurface("lk-1", "oc_1", "group_menu")).toBeDefined()
  })

  it("skips items with no chat_id", async () => {
    const { request } = pagedRequest([[{ chat_mode: "group" }, { chat_id: "oc_1" }]])
    const result = await seedLarkChatSurfaces(seedInput(), {
      request: request as never,
      getAdapter: async () => adapterRow({ larkChatTab: true, larkGroupMenu: false }),
    })
    expect(result).toEqual({ chats: 2, seeded: 1 })
  })

  it("is idempotent — re-seeding a synced row leaves it synced", async () => {
    const { request } = pagedRequest([[{ chat_id: "oc_1" }]])
    const deps = {
      request: request as never,
      getAdapter: async () => adapterRow({ larkChatTab: true, larkGroupMenu: false }),
    }
    await seedLarkChatSurfaces(seedInput(), deps)

    const db = getDb()
    const existing = await getChatSurface("lk-1", "oc_1", "chat_tab")
    await db.larkChatSurfaces.put({ ...existing!, status: "synced", lastSyncAt: 1 })

    await seedLarkChatSurfaces(seedInput(), deps)
    expect((await getChatSurface("lk-1", "oc_1", "chat_tab"))?.status).toBe("synced")
  })

  it("leaves a blocked row blocked instead of re-arming it every sweep", async () => {
    const { request } = pagedRequest([[{ chat_id: "oc_1" }]])
    const deps = {
      request: request as never,
      getAdapter: async () => adapterRow({ larkChatTab: true, larkGroupMenu: false }),
    }
    await seedLarkChatSurfaces(seedInput(), deps)

    const db = getDb()
    const existing = await getChatSurface("lk-1", "oc_1", "chat_tab")
    await db.larkChatSurfaces.put({ ...existing!, status: "blocked", lastError: "missing scope" })

    await seedLarkChatSurfaces(seedInput(), deps)
    expect((await getChatSurface("lk-1", "oc_1", "chat_tab"))?.status).toBe("blocked")
  })
})
