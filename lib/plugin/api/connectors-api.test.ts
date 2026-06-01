/**
 * Tests for the Connectors Plugin API (`ctx.connectors`).
 *
 * Covers the three permission tiers (connectors:read / connectors:send /
 * connectors:manage), the credential-free adapter + instance summary
 * boundaries, outbound forwarding (send/edit/delete/typing/upload), the
 * passive inbound + callback observers, history/runtime reads, and instance
 * management delegation.
 */

import { createConnectorsAPI } from "./connectors-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"

// ── bus mock ──────────────────────────────────────────────────────────────────
const sendOutbound = jest.fn(async () => ({ ok: true, platformMessageId: "m1" }))
const editOutbound = jest.fn(async () => ({ ok: true, platformMessageId: "m2" }))
const deleteOutbound = jest.fn(async () => ({ ok: true }))
const setTypingOutbound = jest.fn(async () => true)
const uploadFileOutbound = jest.fn(async () => ({ localUrl: "file://x", remoteRef: "rr" }))
const fetchHistoryAll = jest.fn(async () => [{ messageId: "h1" }])
const inboundObservers = new Set<(e: unknown) => void>()
const callbackObservers = new Set<(e: unknown, k: string | null) => void>()
const subscribeInbound = jest.fn((obs: (e: unknown) => void) => {
  inboundObservers.add(obs)
  return () => inboundObservers.delete(obs)
})
const subscribeCallback = jest.fn((obs: (e: unknown, k: string | null) => void) => {
  callbackObservers.add(obs)
  return () => callbackObservers.delete(obs)
})

function makeAdapter(id: string, withOps = false) {
  return {
    id,
    meta: {
      type: "telegram",
      displayName: `Adapter ${id}`,
      version: "1.0.0",
      capabilities: ["text"],
      transportModes: ["longpoll"],
    },
    health: () => ({ state: "running" }),
    // Sensitive surface that must NOT leak through the summary:
    start: jest.fn(),
    stop: jest.fn(),
    refreshCredentials: jest.fn(),
    send: jest.fn(),
    // Optional capabilities — only the second adapter advertises them.
    ...(withOps
      ? {
          edit: jest.fn(),
          delete: jest.fn(),
          setTyping: jest.fn(),
          uploadFile: jest.fn(),
          fetchHistory: jest.fn(),
          streamReply: jest.fn(),
        }
      : {}),
  }
}
const adapters = new Map([
  ["tg", makeAdapter("tg")],
  ["sl", makeAdapter("sl", true)],
])
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({
    listAdapters: () => Array.from(adapters.values()),
    getAdapter: (id: string) => adapters.get(id),
    sendOutbound: (...a: unknown[]) => sendOutbound(...a),
    editOutbound: (...a: unknown[]) => editOutbound(...a),
    deleteOutbound: (...a: unknown[]) => deleteOutbound(...a),
    setTypingOutbound: (...a: unknown[]) => setTypingOutbound(...a),
    uploadFileOutbound: (...a: unknown[]) => uploadFileOutbound(...a),
    fetchHistoryAll: (...a: unknown[]) => fetchHistoryAll(...a),
    subscribeInbound: (...a: unknown[]) => subscribeInbound(...(a as [(e: unknown) => void])),
    subscribeCallback: (...a: unknown[]) =>
      subscribeCallback(...(a as [(e: unknown, k: string | null) => void])),
  }),
}))

// ── db / runtime mocks ──────────────────────────────────────────────────────
const INSTANCE_ROW = {
  id: "cai_1",
  type: "telegram",
  displayName: "My Bot",
  enabled: true,
  transportMode: "longpoll",
  settings: { foo: 1 },
  // The keyring pointer must be stripped before crossing the plugin boundary.
  credentialsRef: { keyringService: "svc", accounts: ["a"] },
  trigger: {},
  defaultMode: "ai-run",
  createdAt: 1,
  updatedAt: 1,
}
const createAdapterInstance = jest.fn(async () => ({ ...INSTANCE_ROW, id: "cai_new" }))
const updateAdapterInstance = jest.fn(async () => undefined)
const deleteAdapterInstance = jest.fn(async () => undefined)
const getAdapterInstance = jest.fn(async (id: string) =>
  id === "cai_1" ? INSTANCE_ROW : undefined
)
const listAdapterInstances = jest.fn(async () => [INSTANCE_ROW])
jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...a: unknown[]) => createAdapterInstance(...(a as [never])),
  updateAdapterInstance: (...a: unknown[]) => updateAdapterInstance(...(a as [never, never])),
  deleteAdapterInstance: (...a: unknown[]) => deleteAdapterInstance(...(a as [never])),
  getAdapterInstance: (...a: unknown[]) => getAdapterInstance(...(a as [string])),
  listAdapterInstances: () => listAdapterInstances(),
}))

const getAdapterRuntimeStateSnapshot = jest.fn((id: string) =>
  id === "tg" ? { breaker: { state: "closed" }, bucket: { tokens: 20 } } : null
)
jest.mock("@/lib/connectors/outbound-runner", () => ({
  getAdapterRuntimeStateSnapshot: (...a: unknown[]) =>
    getAdapterRuntimeStateSnapshot(...(a as [string])),
}))

jest.mock("@/types/connectors/outbound", () => ({
  newIdempotencyKey: () => "idem-123",
}))

const PLUGIN = "conn-plugin"

describe("createConnectorsAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    inboundObservers.clear()
    callbackObservers.clear()
    resetPermissionGuard()
    guard = getPermissionGuard()
  })

  describe("permission gating", () => {
    it("read-tier methods need connectors:read", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createConnectorsAPI(PLUGIN)
      expect(() => api.listAdapters()).toThrow(PermissionError)
      expect(() => api.getAdapter("tg")).toThrow(PermissionError)
      expect(() => api.listInstances()).toThrow(PermissionError)
      expect(() => api.getInstance("cai_1")).toThrow(PermissionError)
      expect(() => api.getRuntimeState("tg")).toThrow(PermissionError)
      expect(() => api.fetchHistory("tg", "k")).toThrow(PermissionError)
      expect(() => api.onCallback(jest.fn())).toThrow(PermissionError)
    })

    it("send-tier methods need connectors:send (read alone is insufficient)", () => {
      guard.registerPlugin(PLUGIN, ["connectors:read"])
      const api = createConnectorsAPI(PLUGIN)
      expect(() => api.listAdapters()).not.toThrow()
      expect(() => api.send("tg", {} as never)).toThrow(PermissionError)
      expect(() => api.editMessage("tg", "m", {} as never)).toThrow(PermissionError)
      expect(() => api.deleteMessage("tg", "m")).toThrow(PermissionError)
      expect(() => api.setTyping("tg", "k", true)).toThrow(PermissionError)
      expect(() => api.uploadFile("tg", { url: "u" })).toThrow(PermissionError)
      expect(sendOutbound).not.toHaveBeenCalled()
    })

    it("manage-tier methods need connectors:manage (send is insufficient)", () => {
      guard.registerPlugin(PLUGIN, ["connectors:read", "connectors:send"])
      const api = createConnectorsAPI(PLUGIN)
      expect(() => api.createInstance({} as never)).toThrow(PermissionError)
      expect(() => api.updateInstance("cai_1", {})).toThrow(PermissionError)
      expect(() => api.setInstanceEnabled("cai_1", false)).toThrow(PermissionError)
      expect(() => api.deleteInstance("cai_1")).toThrow(PermissionError)
      expect(createAdapterInstance).not.toHaveBeenCalled()
      expect(deleteAdapterInstance).not.toHaveBeenCalled()
    })
  })

  describe("reads", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["connectors:read"]))

    it("listAdapters returns credential-free summaries with capability flags", () => {
      const api = createConnectorsAPI(PLUGIN)
      const list = api.listAdapters()
      expect(list).toHaveLength(2)
      const tg = list[0]
      expect(tg).toEqual({
        id: "tg",
        type: "telegram",
        displayName: "Adapter tg",
        version: "1.0.0",
        capabilities: ["text"],
        transportModes: ["longpoll"],
        health: { state: "running" },
        supports: {
          edit: false,
          delete: false,
          setTyping: false,
          uploadFile: false,
          fetchHistory: false,
          streamReply: false,
        },
      })
      // The live adapter's sensitive methods never appear on the summary.
      expect(tg).not.toHaveProperty("start")
      expect(tg).not.toHaveProperty("refreshCredentials")
      expect(tg).not.toHaveProperty("send")
      // The ops-capable adapter advertises its optional methods.
      expect(list[1].supports).toEqual({
        edit: true,
        delete: true,
        setTyping: true,
        uploadFile: true,
        fetchHistory: true,
        streamReply: true,
      })
    })

    it("getAdapter returns one summary or null", () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(api.getAdapter("sl")?.id).toBe("sl")
      expect(api.getAdapter("nope")).toBeNull()
    })

    it("listInstances strips the keyring pointer", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const list = await api.listInstances()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe("cai_1")
      expect(list[0].displayName).toBe("My Bot")
      expect(list[0]).not.toHaveProperty("credentialsRef")
    })

    it("getInstance returns one stripped row or null", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const row = await api.getInstance("cai_1")
      expect(row?.id).toBe("cai_1")
      expect(row).not.toHaveProperty("credentialsRef")
      expect(await api.getInstance("missing")).toBeNull()
    })

    it("getRuntimeState forwards to the runner snapshot", () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(api.getRuntimeState("tg")).toEqual({
        breaker: { state: "closed" },
        bucket: { tokens: 20 },
      })
      expect(api.getRuntimeState("nope")).toBeNull()
    })

    it("fetchHistory forwards adapterId/key/opts to the bus", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const res = await api.fetchHistory("tg", "telegram:tg:42", { max: 5 })
      expect(res).toEqual([{ messageId: "h1" }])
      expect(fetchHistoryAll).toHaveBeenCalledWith("tg", "telegram:tg:42", { max: 5 })
    })

    it("onInbound subscribes a passive observer and disposes", () => {
      const api = createConnectorsAPI(PLUGIN)
      const handler = jest.fn()
      const dispose = api.onInbound(handler)
      expect(subscribeInbound).toHaveBeenCalledWith(handler)
      expect(inboundObservers.size).toBe(1)
      for (const obs of inboundObservers) obs({ kind: "message", messageId: "x" })
      expect(handler).toHaveBeenCalledWith({ kind: "message", messageId: "x" })
      dispose()
      expect(inboundObservers.size).toBe(0)
    })

    it("onCallback subscribes a passive callback observer and disposes", () => {
      const api = createConnectorsAPI(PLUGIN)
      const handler = jest.fn()
      const dispose = api.onCallback(handler)
      expect(subscribeCallback).toHaveBeenCalledWith(handler)
      expect(callbackObservers.size).toBe(1)
      for (const obs of callbackObservers) obs({ triggerId: "t1" }, "telegram:tg:42")
      expect(handler).toHaveBeenCalledWith({ triggerId: "t1" }, "telegram:tg:42")
      dispose()
      expect(callbackObservers.size).toBe(0)
    })
  })

  describe("outbound mutations", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["connectors:read", "connectors:send"]))

    it("send forwards a full outbound request", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const req = { conversationRef: { x: 1 }, segments: [], metadata: { idempotencyKey: "k" } }
      const res = await api.send("tg", req as never)
      expect(res).toEqual({ ok: true, platformMessageId: "m1" })
      expect(sendOutbound).toHaveBeenCalledWith("tg", req)
    })

    it("sendText wraps text into a single segment with a fresh idempotency key", async () => {
      const api = createConnectorsAPI(PLUGIN)
      await api.sendText("tg", { conv: "c1" } as never, "hello")
      expect(sendOutbound).toHaveBeenCalledWith("tg", {
        conversationRef: { conv: "c1" },
        segments: [{ type: "text", text: "hello" }],
        metadata: { idempotencyKey: "idem-123" },
      })
    })

    it("editMessage / deleteMessage forward to the bus", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const patch = { conversationRef: {}, segments: [], metadata: { idempotencyKey: "k" } }
      expect(await api.editMessage("tg", "pm_1", patch as never)).toEqual({
        ok: true,
        platformMessageId: "m2",
      })
      expect(editOutbound).toHaveBeenCalledWith("tg", "pm_1", patch)
      expect(await api.deleteMessage("tg", "pm_1")).toEqual({ ok: true })
      expect(deleteOutbound).toHaveBeenCalledWith("tg", "pm_1")
    })

    it("setTyping / uploadFile forward to the bus", async () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(await api.setTyping("tg", "telegram:tg:42", true)).toBe(true)
      expect(setTypingOutbound).toHaveBeenCalledWith("tg", "telegram:tg:42", true)
      expect(await api.uploadFile("tg", { url: "u" })).toEqual({
        localUrl: "file://x",
        remoteRef: "rr",
      })
      expect(uploadFileOutbound).toHaveBeenCalledWith("tg", { url: "u" })
    })
  })

  describe("instance management", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["connectors:manage"]))

    it("createInstance delegates and returns a stripped summary", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const input = { type: "telegram", displayName: "New" } as never
      const info = await api.createInstance(input)
      expect(createAdapterInstance).toHaveBeenCalledWith(input)
      expect(info.id).toBe("cai_new")
      expect(info).not.toHaveProperty("credentialsRef")
    })

    it("updateInstance forwards the patch verbatim", async () => {
      const api = createConnectorsAPI(PLUGIN)
      await api.updateInstance("cai_1", { displayName: "Renamed", muted: true })
      expect(updateAdapterInstance).toHaveBeenCalledWith("cai_1", {
        displayName: "Renamed",
        muted: true,
      })
    })

    it("setInstanceEnabled patches only the enabled flag", async () => {
      const api = createConnectorsAPI(PLUGIN)
      await api.setInstanceEnabled("cai_1", false)
      expect(updateAdapterInstance).toHaveBeenCalledWith("cai_1", { enabled: false })
    })

    it("deleteInstance delegates to the db layer", async () => {
      const api = createConnectorsAPI(PLUGIN)
      await api.deleteInstance("cai_1")
      expect(deleteAdapterInstance).toHaveBeenCalledWith("cai_1")
    })
  })
})
