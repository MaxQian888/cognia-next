jest.mock("@/lib/connectors/lifecycle", () => ({
  getRunningAdapter: jest.fn(),
  listRunningAdapters: jest.fn(() => []),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  updateAdapterInstance: jest.fn().mockResolvedValue(undefined),
}))

import { getRunningAdapter, listRunningAdapters } from "@/lib/connectors/lifecycle"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { ChatManagementScopeError } from "@/types/connectors/chat-management"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import { previewText, requireMethod, resolveChatCapableAdapter, withScopeCapture } from "./_helpers"

const mGet = getRunningAdapter as jest.Mock
const mList = listRunningAdapters as jest.Mock
const mRowGet = getAdapterInstance as jest.Mock
const mRowUpdate = updateAdapterInstance as jest.Mock

function makeAdapter(over: Partial<PlatformAdapter> & { id: string }): PlatformAdapter {
  return {
    meta: {
      type: "lark",
      displayName: "Bot",
      version: "0",
      capabilities: ["chat.create", "chat.members"],
      transportModes: ["webhook"],
      configSchema: {},
    },
    start: jest.fn(),
    stop: jest.fn(),
    health: () => ({ state: "running" }),
    send: jest.fn(),
    a2uiCapability: () => ({}) as never,
    createChat: jest.fn(),
    ...over,
  } as unknown as PlatformAdapter
}

function entry(adapter: PlatformAdapter) {
  return { adapter, abortController: new AbortController(), restart: jest.fn() }
}

beforeEach(() => {
  jest.clearAllMocks()
  mList.mockReturnValue([])
})

describe("resolveChatCapableAdapter", () => {
  it("uses the explicit adapterId when provided", async () => {
    const adapter = makeAdapter({ id: "a-explicit" })
    mGet.mockReturnValue(entry(adapter))
    const out = await resolveChatCapableAdapter({ sessionId: "s" }, ["chat.create"], "a-explicit")
    expect(out.adapterId).toBe("a-explicit")
    expect(out.platform).toBe("lark")
    expect(mGet).toHaveBeenCalledWith("a-explicit")
  })

  it("falls back to the session's IM binding", async () => {
    const adapter = makeAdapter({ id: "a-im" })
    mGet.mockReturnValue(entry(adapter))
    const out = await resolveChatCapableAdapter(
      {
        sessionId: "s",
        imBinding: { adapterId: "a-im", platform: "lark", conversationKey: "lark:a-im:oc_1" },
      },
      ["chat.create"]
    )
    expect(out.adapterId).toBe("a-im")
  })

  it("desktop fallback picks the single capable running adapter", async () => {
    const capable = makeAdapter({ id: "a-cap" })
    const incapable = makeAdapter({ id: "a-no" })
    ;(incapable.meta.capabilities as unknown) = ["send.text"]
    mList.mockReturnValue([entry(incapable), entry(capable)])
    mGet.mockReturnValue(entry(capable))
    const out = await resolveChatCapableAdapter({ sessionId: "s" }, ["chat.create"])
    expect(out.adapterId).toBe("a-cap")
  })

  it("desktop fallback with zero capable adapters throws an actionable error", async () => {
    await expect(resolveChatCapableAdapter({ sessionId: "s" }, ["chat.create"])).rejects.toThrow(
      /No connected platform supports this operation.*chat\.create/
    )
  })

  it("desktop fallback with multiple capable adapters lists the candidates", async () => {
    mList.mockReturnValue([entry(makeAdapter({ id: "a1" })), entry(makeAdapter({ id: "a2" }))])
    await expect(resolveChatCapableAdapter({ sessionId: "s" }, ["chat.create"])).rejects.toThrow(
      /Multiple connected bots.*a1.*a2/
    )
  })

  it("throws when the adapter is not running", async () => {
    mGet.mockReturnValue(undefined)
    await expect(
      resolveChatCapableAdapter({ sessionId: "s" }, ["chat.create"], "ghost")
    ).rejects.toThrow(/not running/)
  })

  it("throws when the adapter is unhealthy", async () => {
    const adapter = makeAdapter({ id: "a-down", health: () => ({ state: "down" }) } as never)
    mGet.mockReturnValue(entry(adapter))
    await expect(
      resolveChatCapableAdapter({ sessionId: "s" }, ["chat.create"], "a-down")
    ).rejects.toThrow(/not healthy/)
  })

  it("throws when the resolved adapter lacks a required capability", async () => {
    const adapter = makeAdapter({ id: "a-nocap" })
    ;(adapter.meta.capabilities as unknown) = ["send.text"]
    mGet.mockReturnValue(entry(adapter))
    await expect(
      resolveChatCapableAdapter({ sessionId: "s" }, ["chat.update"], "a-nocap")
    ).rejects.toThrow(/does not declare/)
  })
})

describe("requireMethod", () => {
  it("returns the method when implemented and throws an adapter-bug error when absent", async () => {
    const adapter = makeAdapter({ id: "a1" })
    mGet.mockReturnValue(entry(adapter))
    const resolved = await resolveChatCapableAdapter({ sessionId: "s" }, ["chat.create"], "a1")
    expect(typeof requireMethod(resolved, "createChat")).toBe("function")
    expect(() => requireMethod(resolved, "updateChat")).toThrow(/adapter bug/)
  })
})

describe("withScopeCapture", () => {
  it("persists the missing scope onto the adapter row and rethrows", async () => {
    mRowGet.mockResolvedValue({ id: "a1", lastMissingScopes: ["existing:scope"] })
    const err = new ChatManagementScopeError("missing", "im:chat:create", "lark")
    await expect(withScopeCapture("a1", () => Promise.reject(err))).rejects.toBe(err)
    expect(mRowUpdate).toHaveBeenCalledWith("a1", {
      lastMissingScopes: ["existing:scope", "im:chat:create"],
    })
  })

  it("does not re-persist an already-recorded scope", async () => {
    mRowGet.mockResolvedValue({ id: "a1", lastMissingScopes: ["im:chat:create"] })
    const err = new ChatManagementScopeError("missing", "im:chat:create", "lark")
    await expect(withScopeCapture("a1", () => Promise.reject(err))).rejects.toBe(err)
    expect(mRowUpdate).not.toHaveBeenCalled()
  })

  it("passes non-scope errors through untouched, without a persist", async () => {
    await expect(withScopeCapture("a1", () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom"
    )
    expect(mRowUpdate).not.toHaveBeenCalled()
  })

  it("returns the value on success", async () => {
    expect(await withScopeCapture("a1", () => Promise.resolve(42))).toBe(42)
  })
})

describe("previewText", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(previewText("  a   b\n c ")).toBe("a b c")
    expect(previewText("x".repeat(200), 10)).toBe("xxxxxxxxxx…")
  })
})
