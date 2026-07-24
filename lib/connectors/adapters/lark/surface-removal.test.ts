/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { ensureChatSurface, getChatSurface } from "@/lib/db/lark-chat-surfaces"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { removeChatSurface, removeDisabledLarkSurfaces } from "./surface-removal"

const ADAPTER_ID = "lark-rm-1"
const ctx = { adapterId: ADAPTER_ID, resolveCreds: async () => ({ appId: "cli", appSecret: "s" }) }

function adapterRow(settings: Record<string, unknown>) {
  return { id: ADAPTER_ID, platform: "lark", settings } as unknown as AdapterInstanceRow
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    request: jest.fn(async () => ({})),
    audit: jest.fn(async () => undefined),
    now: () => 1_700_000_000_000,
    ...overrides,
  } as never
}

async function seed(
  chatId: string,
  surfaceType: "chat_tab" | "group_menu",
  platformSurfaceId?: string
) {
  await ensureChatSurface({ adapterId: ADAPTER_ID, chatId, surfaceType, urlVersion: 1 })
  if (platformSurfaceId) {
    const row = await getChatSurface(ADAPTER_ID, chatId, surfaceType)
    await getDb().larkChatSurfaces.put({ ...row!, platformSurfaceId, status: "synced" })
  }
}

describe("removeChatSurface", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("deletes a chat tab by tab_ids and retires the row", async () => {
    await seed("oc_1", "chat_tab", "tab_9")
    const deps = makeDeps()

    const ok = await removeChatSurface(
      ctx,
      { chatId: "oc_1", surfaceType: "chat_tab", platformSurfaceId: "tab_9" },
      deps
    )

    expect(ok).toBe(true)
    const [, method, urlPath, body] = (deps as never as { request: jest.Mock }).request.mock
      .calls[0]
    expect(method).toBe("DELETE")
    expect(urlPath).toBe("/im/v1/chats/oc_1/chat_tabs/delete_tabs")
    expect(body).toEqual({ tab_ids: ["tab_9"] })
    expect((await getChatSurface(ADAPTER_ID, "oc_1", "chat_tab"))?.status).toBe("removed")
  })

  it("deletes a group menu by chat_menu_top_level_ids", async () => {
    await seed("oc_2", "group_menu", "menu_3")
    const deps = makeDeps()

    await removeChatSurface(
      ctx,
      { chatId: "oc_2", surfaceType: "group_menu", platformSurfaceId: "menu_3" },
      deps
    )

    const [, method, urlPath, body] = (deps as never as { request: jest.Mock }).request.mock
      .calls[0]
    expect(method).toBe("DELETE")
    expect(urlPath).toBe("/im/v1/chats/oc_2/menu_tree")
    expect(body).toEqual({ chat_menu_top_level_ids: ["menu_3"] })
  })

  it("retires the row without calling the platform when no id is known", async () => {
    await seed("oc_3", "chat_tab")
    const deps = makeDeps()

    const ok = await removeChatSurface(ctx, { chatId: "oc_3", surfaceType: "chat_tab" }, deps)

    expect(ok).toBe(true)
    expect((deps as never as { request: jest.Mock }).request).not.toHaveBeenCalled()
    expect((await getChatSurface(ADAPTER_ID, "oc_3", "chat_tab"))?.status).toBe("removed")
  })

  it("still retires the row when the platform delete fails, and says so", async () => {
    await seed("oc_4", "chat_tab", "tab_1")
    const deps = makeDeps({
      request: jest.fn(async () => {
        throw new Error("bot is not in the chat")
      }),
    })

    const ok = await removeChatSurface(
      ctx,
      { chatId: "oc_4", surfaceType: "chat_tab", platformSurfaceId: "tab_1" },
      deps
    )

    expect(ok).toBe(false)
    expect((await getChatSurface(ADAPTER_ID, "oc_4", "chat_tab"))?.status).toBe("removed")
    const audit = (deps as never as { audit: jest.Mock }).audit.mock.calls[0][0]
    expect(audit).toMatchObject({ kind: "chat_tab.removed", reason: "platform_delete_failed" })
  })
})

describe("removeDisabledLarkSurfaces", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("withdraws only the surfaces whose flag is now off", async () => {
    await seed("oc_1", "chat_tab", "tab_1")
    await seed("oc_1", "group_menu", "menu_1")
    const deps = makeDeps({ getAdapter: async () => adapterRow({ larkChatTab: true }) })

    const result = await removeDisabledLarkSurfaces(ctx, deps)

    expect(result).toEqual({ removed: 1, failed: 0 })
    expect((await getChatSurface(ADAPTER_ID, "oc_1", "chat_tab"))?.status).toBe("synced")
    expect((await getChatSurface(ADAPTER_ID, "oc_1", "group_menu"))?.status).toBe("removed")
  })

  it("skips rows already removed", async () => {
    await seed("oc_1", "chat_tab", "tab_1")
    await getDb().larkChatSurfaces.put({
      ...(await getChatSurface(ADAPTER_ID, "oc_1", "chat_tab"))!,
      status: "removed",
    })
    const deps = makeDeps({ getAdapter: async () => adapterRow({}) })

    expect(await removeDisabledLarkSurfaces(ctx, deps)).toEqual({ removed: 0, failed: 0 })
    expect((deps as never as { request: jest.Mock }).request).not.toHaveBeenCalled()
  })

  it("counts a failed platform delete separately", async () => {
    await seed("oc_1", "chat_tab", "tab_1")
    const deps = makeDeps({
      getAdapter: async () => adapterRow({}),
      request: jest.fn(async () => {
        throw new Error("gone")
      }),
    })

    expect(await removeDisabledLarkSurfaces(ctx, deps)).toEqual({ removed: 0, failed: 1 })
  })

  it("does nothing when both flags are still on", async () => {
    await seed("oc_1", "chat_tab", "tab_1")
    await seed("oc_1", "group_menu", "menu_1")
    const deps = makeDeps({
      getAdapter: async () => adapterRow({ larkChatTab: true, larkGroupMenu: true }),
    })

    expect(await removeDisabledLarkSurfaces(ctx, deps)).toEqual({ removed: 0, failed: 0 })
  })
})
