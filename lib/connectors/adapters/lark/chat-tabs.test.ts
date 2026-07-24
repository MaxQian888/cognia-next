/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { getChatSurface } from "@/lib/db/lark-chat-surfaces"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import {
  CHAT_TAB_WRITE_SCOPE,
  isTerminalSurfaceRefusal,
  reconcileChatTabSurface,
  runSurfaceLocked,
} from "./chat-tabs"
import { LarkApiError } from "./auth-retry"

const ADAPTER_ID = "lark-tabs-1"
const CHAT_ID = "oc_chat_1"
const URL = "https://cognia.example/lark/entry?surface=tok_1"

function adapterRow(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: ADAPTER_ID,
    platform: "lark",
    displayName: "Tabs Bot",
    enabled: true,
    settings: { larkChatTab: true },
    lastWhoamiResult: {
      botName: "Tabs Bot",
      appId: "cli_1",
      openId: "ou_bot",
      tenantKey: "tk_1",
    },
    ...overrides,
  } as unknown as AdapterInstanceRow
}

function deps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    request: jest.fn(async (_c: unknown, _m: unknown, _p: string, _b?: unknown) => ({
      data: { chat_tabs: [] },
    })),
    getAdapter: jest.fn(async (_id: string) => adapterRow()),
    audit: jest.fn(async (_entry: unknown) => undefined),
    buildUrl: jest.fn(async (_input: unknown) => URL),
    now: () => 1_700_000_000_000,
    ...overrides,
  } as never
}

const ctx = {
  adapterId: ADAPTER_ID,
  resolveCreds: async () => ({ appId: "cli_1", appSecret: "s" }),
}

describe("reconcileChatTabSurface", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("skips without touching the platform when the flag is off", async () => {
    const d = deps({ getAdapter: jest.fn(async () => adapterRow({ settings: {} })) })
    expect(await reconcileChatTabSurface(ctx, CHAT_ID, d)).toBe("skipped")
    expect((d as { request: jest.Mock }).request).not.toHaveBeenCalled()
  })

  it("fails closed with identity_unknown before tenant_key is backfilled", async () => {
    const row = adapterRow()
    delete (row.lastWhoamiResult as { tenantKey?: string }).tenantKey
    const d = deps({ getAdapter: jest.fn(async () => row) })
    expect(await reconcileChatTabSurface(ctx, CHAT_ID, d)).toBe("error")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "chat_tab")
    expect(stored?.status).toBe("error")
    expect(stored?.lastError).toBe("identity_unknown")
    expect(stored?.nextAttemptAt).toBeGreaterThan(1_700_000_000_000)
    expect((d as { request: jest.Mock }).request).not.toHaveBeenCalled()
  })

  it("records web_entry_unconfigured when no surface URL can be built", async () => {
    const d = deps({ buildUrl: jest.fn(async () => null) })
    expect(await reconcileChatTabSurface(ctx, CHAT_ID, d)).toBe("error")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "chat_tab")
    expect(stored?.lastError).toBe("web_entry_unconfigured")
    const audit = (d as { audit: jest.Mock }).audit.mock.calls[0][0] as Record<string, unknown>
    expect(audit.kind).toBe("chat_tab.sync_failed")
  })

  it("creates the Cognia tab when the platform has none (list-before-write)", async () => {
    const request = jest.fn(async (_c: unknown, method: string, path: string) => {
      if (path.endsWith("/chat_tabs/list_tabs")) return { data: { chat_tabs: [] } }
      expect(method).toBe("POST")
      expect(path).toBe(`/im/v1/chats/${CHAT_ID}/chat_tabs`)
      return { data: { chat_tabs: [{ tab_id: "tab_9", tab_name: "Cognia" }] } }
    })
    const d = deps({ request })
    expect(await reconcileChatTabSurface(ctx, CHAT_ID, d)).toBe("synced")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "chat_tab")
    expect(stored?.status).toBe("synced")
    expect(stored?.platformSurfaceId).toBe("tab_9")
    expect(stored?.desiredUrl).toBe(URL)
    const kinds = (d as { audit: jest.Mock }).audit.mock.calls.map(
      (c) => (c[0] as { kind: string }).kind
    )
    expect(kinds).toContain("chat_tab.synced")
  })

  it("updates in place when the existing tab points at a stale URL", async () => {
    const calls: string[] = []
    const request = jest.fn(async (_c: unknown, _m: string, path: string, body?: unknown) => {
      calls.push(path)
      if (path.endsWith("/list_tabs")) {
        return {
          data: {
            chat_tabs: [
              { tab_id: "tab_old", tab_name: "Cognia", tab_content: { url: "https://old" } },
            ],
          },
        }
      }
      expect(path).toBe(`/im/v1/chats/${CHAT_ID}/chat_tabs/update_tabs`)
      const tabs = (body as { chat_tabs: Array<{ tab_id: string; tab_content: { url: string } }> })
        .chat_tabs
      expect(tabs[0].tab_id).toBe("tab_old")
      expect(tabs[0].tab_content.url).toBe(URL)
      return {}
    })
    const d = deps({ request })
    expect(await reconcileChatTabSurface(ctx, CHAT_ID, d)).toBe("synced")
    expect(calls).toHaveLength(2)
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "chat_tab")
    expect(stored?.platformSurfaceId).toBe("tab_old")
  })

  it("writes nothing when the platform already matches the desired URL", async () => {
    const request = jest.fn(async () => ({
      data: { chat_tabs: [{ tab_id: "tab_ok", tab_name: "Cognia", tab_content: { url: URL } }] },
    }))
    const d = deps({ request })
    expect(await reconcileChatTabSurface(ctx, CHAT_ID, d)).toBe("synced")
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("backs off and audits on platform API failure", async () => {
    const request = jest.fn(async () => {
      throw new Error("lark says no")
    })
    const d = deps({ request })
    expect(await reconcileChatTabSurface(ctx, CHAT_ID, d)).toBe("error")
    const stored = await getChatSurface(ADAPTER_ID, CHAT_ID, "chat_tab")
    expect(stored?.status).toBe("error")
    expect(stored?.lastError).toContain("lark says no")
    expect(stored?.attempt).toBe(1)
  })

  it("coalesces concurrent reconciles for the same surface onto one run", async () => {
    let runs = 0
    const first = runSurfaceLocked(ADAPTER_ID, CHAT_ID, "chat_tab", async () => {
      runs += 1
      await new Promise((r) => setTimeout(r, 10))
      return "synced"
    })
    const second = runSurfaceLocked(ADAPTER_ID, CHAT_ID, "chat_tab", async () => {
      runs += 1
      return "synced"
    })
    expect(await Promise.all([first, second])).toEqual(["synced", "synced"])
    expect(runs).toBe(1)
  })
})

describe("isTerminalSurfaceRefusal", () => {
  it("treats a missing write scope as terminal", () => {
    const err = new LarkApiError({ status: 403, code: null, message: "permission denied" })
    expect(isTerminalSurfaceRefusal(err, CHAT_TAB_WRITE_SCOPE)).toBe(true)
  })

  it("treats a group-only refusal as terminal so p2p chats stop retrying", () => {
    expect(isTerminalSurfaceRefusal(new Error("p2p chat is not supported"), "s")).toBe(true)
    expect(isTerminalSurfaceRefusal(new Error("unsupported chat type"), "s")).toBe(true)
  })

  it("leaves transient failures retryable", () => {
    expect(isTerminalSurfaceRefusal(new Error("network timeout"), "s")).toBe(false)
    expect(
      isTerminalSurfaceRefusal(
        new LarkApiError({ status: 500, code: null, message: "server error" }),
        "s"
      )
    ).toBe(false)
  })
})
