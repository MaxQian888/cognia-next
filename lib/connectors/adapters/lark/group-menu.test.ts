/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { getChatSurface } from "@/lib/db/lark-chat-surfaces"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { reconcileGroupMenuSurface } from "./group-menu"

const ADAPTER_ID = "lark-menu-tree-1"
const CHAT_ID = "oc_group_1"
const URL = "https://cognia.example/lark/entry?surface=tok_menu"

function adapterRow(settings: Record<string, unknown> = { larkGroupMenu: true }) {
  return {
    id: ADAPTER_ID,
    platform: "lark",
    displayName: "Menu Bot",
    enabled: true,
    settings,
    lastWhoamiResult: {
      botName: "Menu Bot",
      appId: "cli_1",
      openId: "ou_bot",
      tenantKey: "tk_1",
    },
  } as unknown as AdapterInstanceRow
}

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    request: jest.fn(async () => ({ data: { menu_tree: { chat_menu_top_levels: [] } } })),
    getAdapter: jest.fn(async () => adapterRow()),
    audit: jest.fn(async () => undefined),
    buildUrl: jest.fn(async () => URL),
    now: () => 1_700_000_000_000,
    ...overrides,
  } as never
}

const ctx = {
  adapterId: ADAPTER_ID,
  resolveCreds: async () => ({ appId: "cli_1", appSecret: "s" }),
}

describe("reconcileGroupMenuSurface", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("skips when larkGroupMenu is off (chat-tab flag does not leak over)", async () => {
    const d = deps({
      getAdapter: jest.fn(async () => adapterRow({ larkChatTab: true, larkGroupMenu: false })),
    })
    expect(await reconcileGroupMenuSurface(ctx, CHAT_ID, d)).toBe("skipped")
    expect((d as { request: jest.Mock }).request).not.toHaveBeenCalled()
  })

  it("creates the REDIRECT_LINK menu when the tree has no Cognia entry", async () => {
    const request = jest.fn(async (_c: unknown, method: string, path: string, body?: unknown) => {
      if (method === "GET") {
        expect(path).toBe(`/im/v1/chats/${CHAT_ID}/menu_tree`)
        return { data: { menu_tree: { chat_menu_top_levels: [] } } }
      }
      expect(method).toBe("POST")
      expect(path).toBe(`/im/v1/chats/${CHAT_ID}/menu_tree`)
      const item = (
        body as {
          menu_tree: {
            chat_menu_top_levels: Array<{
              chat_menu_item: {
                action_type: string
                name: string
                redirect_link: { common_url: string }
              }
            }>
          }
        }
      ).menu_tree.chat_menu_top_levels[0].chat_menu_item
      expect(item.action_type).toBe("REDIRECT_LINK")
      expect(item.name).toBe("Cognia")
      expect(item.redirect_link.common_url).toBe(URL)
      return {
        data: {
          menu_tree: {
            chat_menu_top_levels: [
              { chat_menu_top_level_id: "menu_9", chat_menu_item: { name: "Cognia" } },
            ],
          },
        },
      }
    })
    const d = deps({ request })
    expect(await reconcileGroupMenuSurface(ctx, CHAT_ID, d)).toBe("synced")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "group_menu")
    expect(stored?.status).toBe("synced")
    expect(stored?.platformSurfaceId).toBe("menu_9")
  })

  it("patches the existing item via /menu_items/{id} when the URL is stale", async () => {
    const request = jest.fn(async (_c: unknown, method: string, path: string, body?: unknown) => {
      if (method === "GET") {
        return {
          data: {
            menu_tree: {
              chat_menu_top_levels: [
                {
                  chat_menu_top_level_id: "menu_old",
                  chat_menu_item: {
                    name: "Cognia",
                    redirect_link: { common_url: "https://stale" },
                  },
                },
              ],
            },
          },
        }
      }
      expect(method).toBe("PATCH")
      // Pinned trap: the patch resource segment is menu_items, not menu_tree.
      expect(path).toBe(`/im/v1/chats/${CHAT_ID}/menu_items/menu_old`)
      expect((body as { update_fields: string[] }).update_fields).toEqual(["REDIRECT_LINK"])
      return {}
    })
    const d = deps({ request })
    expect(await reconcileGroupMenuSurface(ctx, CHAT_ID, d)).toBe("synced")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "group_menu")
    expect(stored?.platformSurfaceId).toBe("menu_old")
  })

  it("audits sync_failed with the group_menu surfaceType on API failure", async () => {
    const request = jest.fn(async () => {
      throw new Error("menu boom")
    })
    const d = deps({ request })
    expect(await reconcileGroupMenuSurface(ctx, CHAT_ID, d)).toBe("error")
    const audit = (d as { audit: jest.Mock }).audit.mock.calls[0][0] as {
      kind: string
      fields: { surfaceType: string }
    }
    expect(audit.kind).toBe("chat_tab.sync_failed")
    expect(audit.fields.surfaceType).toBe("group_menu")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "group_menu")
    expect(stored?.lastError).toContain("menu boom")
  })

  it("fails closed before tenant identity is known", async () => {
    const row = adapterRow()
    delete (row.lastWhoamiResult as { tenantKey?: string }).tenantKey
    const d = deps({ getAdapter: jest.fn(async () => row) })
    expect(await reconcileGroupMenuSurface(ctx, CHAT_ID, d)).toBe("error")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "group_menu")
    expect(stored?.lastError).toBe("identity_unknown")
    expect((d as { request: jest.Mock }).request).not.toHaveBeenCalled()
  })

  it("records web_entry_unconfigured when no surface URL can be built", async () => {
    const d = deps({ buildUrl: jest.fn(async () => null) })
    expect(await reconcileGroupMenuSurface(ctx, CHAT_ID, d)).toBe("error")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "group_menu")
    expect(stored?.lastError).toBe("web_entry_unconfigured")
  })

  it("writes nothing when the menu already points at the desired URL", async () => {
    const request = jest.fn(async () => ({
      data: {
        menu_tree: {
          chat_menu_top_levels: [
            {
              chat_menu_top_level_id: "menu_ok",
              chat_menu_item: { name: "Cognia", redirect_link: { common_url: URL } },
            },
          ],
        },
      },
    }))
    const d = deps({ request })
    expect(await reconcileGroupMenuSurface(ctx, CHAT_ID, d)).toBe("synced")
    expect(request).toHaveBeenCalledTimes(1)
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "group_menu")
    expect(stored?.platformSurfaceId).toBe("menu_ok")
  })
})
