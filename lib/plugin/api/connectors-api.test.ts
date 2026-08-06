/**
 * @jest-environment jsdom
 *
 * Tests for the Connectors Plugin API (`ctx.connectors`).
 *
 * jsdom (not node) because `connectors:send` / `connectors:manage` are
 * DANGEROUS permissions registered at the "confirm" tier — the consent
 * broker emits its request via `window.dispatchEvent`, and jest.setup.ts's
 * auto-responder (which grants those prompts in tests) only attaches when a
 * window exists.
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

const appendAudit = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: (...args: unknown[]) => appendAudit(...args),
}))

// ── bus mock ──────────────────────────────────────────────────────────────────
const sendOutbound = jest.fn(async (..._a: unknown[]) => ({ ok: true, platformMessageId: "m1" }))
const editOutbound = jest.fn(async (..._a: unknown[]) => ({ ok: true, platformMessageId: "m2" }))
const deleteOutbound = jest.fn(async (..._a: unknown[]) => ({ ok: true }))
const addReactionOutbound = jest.fn(async (..._a: unknown[]) => ({ ok: true, reactionId: "rx_1" }))
const removeReactionOutbound = jest.fn(async (..._a: unknown[]) => ({ ok: true }))
const forwardOutbound = jest.fn(async (..._a: unknown[]) => ({
  ok: true,
  platformMessageId: "om_f",
}))
const pinOutbound = jest.fn(async (..._a: unknown[]) => ({ ok: true }))
const unpinOutbound = jest.fn(async (..._a: unknown[]) => ({ ok: true }))
const sendUrgentOutbound = jest.fn(async (..._a: unknown[]) => ({ ok: true }))
const getReadReceiptOutbound = jest.fn(async (..._a: unknown[]) => ({
  readers: [],
  hasMore: false,
}))
const setTypingOutbound = jest.fn(async (..._a: unknown[]) => true)
const uploadFileOutbound = jest.fn(async (..._a: unknown[]) => ({
  localUrl: "file://x",
  remoteRef: "rr",
}))
const streamReplyOutbound = jest.fn(async (..._a: unknown[]) => true)
const getAdapterA2UICapability = jest.fn((id: string) =>
  id === "sl" ? { Button: "native", Card: "native" } : null
)
const getAdapterSkillCapabilities = jest.fn((id: string) =>
  id === "sl" ? [{ family: "lark.calendar", mutations: ["read", "write"] }] : null
)
const fetchHistoryAll = jest.fn(async (..._a: unknown[]) => [{ messageId: "h1" }])
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
    addReactionOutbound: (...a: unknown[]) => addReactionOutbound(...a),
    removeReactionOutbound: (...a: unknown[]) => removeReactionOutbound(...a),
    forwardOutbound: (...a: unknown[]) => forwardOutbound(...a),
    pinOutbound: (...a: unknown[]) => pinOutbound(...a),
    unpinOutbound: (...a: unknown[]) => unpinOutbound(...a),
    sendUrgentOutbound: (...a: unknown[]) => sendUrgentOutbound(...a),
    getReadReceiptOutbound: (...a: unknown[]) => getReadReceiptOutbound(...a),
    setTypingOutbound: (...a: unknown[]) => setTypingOutbound(...a),
    uploadFileOutbound: (...a: unknown[]) => uploadFileOutbound(...a),
    streamReplyOutbound: (...a: unknown[]) => streamReplyOutbound(...(a as [string, unknown])),
    getAdapterA2UICapability: (...a: unknown[]) => getAdapterA2UICapability(...(a as [string])),
    getAdapterSkillCapabilities: (...a: unknown[]) =>
      getAdapterSkillCapabilities(...(a as [string])),
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
const createAdapterInstance = jest.fn(async (..._a: unknown[]) => ({
  ...INSTANCE_ROW,
  id: "cai_new",
}))
const updateAdapterInstance = jest.fn(async (..._a: unknown[]) => undefined)
const deleteAdapterInstance = jest.fn(async (..._a: unknown[]) => undefined)
const RULE = {
  id: "r1",
  enabled: true,
  match: { keywords: ["deploy"] },
  action: { teamId: "team-1" },
}
const RULES_ROW = { ...INSTANCE_ROW, id: "cai_rules", dispatchRules: [RULE] }
const DISABLED_ROW = { ...INSTANCE_ROW, id: "cai_off", type: "lark", enabled: false }
const getAdapterInstance = jest.fn(async (id: string) =>
  id === "cai_1" ? INSTANCE_ROW : id === "cai_rules" ? RULES_ROW : undefined
)
const listAdapterInstances = jest.fn(async () => [INSTANCE_ROW, DISABLED_ROW])
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

// ── multi-bot surface mocks ──────────────────────────────────────────────────
const SESSION = {
  id: "sess-1",
  title: "Group chat",
  kind: "direct",
  characterId: "char-1",
  platformConversationKey: "telegram:tg:42",
  createdAt: 10,
  updatedAt: 20,
}
const findSessionByConversationKey = jest.fn(async (key: string) =>
  key === "telegram:tg:42" ? SESSION : undefined
)
const listSessionsByConversationKey = jest.fn(async (_key: string) => [SESSION])
const listSiblingConversationsMock = jest.fn(async (_key: string) => [
  { adapterId: "sl", conversationKey: "telegram:sl:42", sessionId: "sess-2" },
])
jest.mock("@/lib/connectors/session-bindings", () => ({
  findSessionByConversationKey: (...a: unknown[]) =>
    findSessionByConversationKey(...(a as [string])),
  listSessionsByConversationKey: (...a: unknown[]) =>
    listSessionsByConversationKey(...(a as [string])),
  listSiblingConversations: (...a: unknown[]) => listSiblingConversationsMock(...(a as [string])),
}))

const bootstrapConversationMock = jest.fn(async (_input: unknown) => ({
  conversationKey: "lark:cai_1:oc_1",
  sessionId: "sess-boot",
  created: true,
}))
jest.mock("@/lib/connectors/conversation-bootstrap", () => ({
  bootstrapConversation: (...a: unknown[]) => bootstrapConversationMock(...(a as [never])),
}))

function makeChatAdapter(id: string, caps: string[], withMethods = true) {
  return {
    adapter: {
      id,
      meta: {
        type: "lark",
        displayName: `Chat ${id}`,
        version: "1.0.0",
        capabilities: caps,
        transportModes: ["websocket"],
      },
      health: jest.fn(() => ({ state: "running" })),
      send: jest.fn(),
      ...(withMethods
        ? {
            createChat: jest.fn(async () => ({ chatId: "oc_new" })),
            updateChat: jest.fn(async () => undefined),
            addChatMembers: jest.fn(async () => ({ succeeded: ["u1"], failed: [] })),
            removeChatMembers: jest.fn(async () => ({ succeeded: ["u1"], failed: [] })),
            resolveContacts: jest.fn(async () => [
              { memberId: "ou_1", displayName: "Ann", confidence: "exact" },
            ]),
          }
        : {}),
    },
    abortController: new AbortController(),
    restart: jest.fn(),
  }
}
const runningEntries = new Map<string, ReturnType<typeof makeChatAdapter>>()
jest.mock("@/lib/connectors/lifecycle", () => ({
  getRunningAdapter: (id: string) => runningEntries.get(id),
  listRunningAdapters: () => Array.from(runningEntries.values()),
}))

const matchDispatchRuleMock = jest.fn((..._a: unknown[]) => ({ rule: RULE, action: RULE.action }))
jest.mock("@/lib/connectors/dispatch-rules", () => ({
  matchDispatchRule: (...a: unknown[]) => matchDispatchRuleMock(...a),
}))

const shouldRespondToMessageMock = jest.fn((..._a: unknown[]) => ({
  allowed: false,
  reason: "chat_blocklist",
}))
jest.mock("@/lib/connectors/at-gate", () => ({
  shouldRespondToMessage: (...a: unknown[]) => shouldRespondToMessageMock(...a),
}))

const enqueueOutbound = jest.fn(
  async (input: { request: { metadata: { idempotencyKey: string } } }) => ({
    id: "oqj_1",
    adapterId: "tg",
    projectId: null,
    conversationKey: "telegram:tg:42",
    request: input.request,
    status: "pending",
    attempts: 0,
    createdAt: 100,
    nextAttemptAt: 100,
    idempotencyKey: input.request.metadata.idempotencyKey,
    source: "plugin",
  })
)
// Delivery-feedback reads (`getOutboundJob` / `waitForDelivery`) hit the
// outboundQueue table directly — stub just that surface of the Dexie db.
const outboundQueueGet = jest.fn(async (_id: string): Promise<unknown> => undefined)
jest.mock("@/lib/db/outbound-jobs", () => ({
  ...jest.requireActual("@/lib/db/outbound-jobs"),
  enqueueOutbound: (...a: unknown[]) => enqueueOutbound(...(a as [never])),
  waitForOutboundTerminal: (id: string) => outboundQueueGet(id),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    outboundQueue: { get: (...a: unknown[]) => outboundQueueGet(...(a as [string])) },
  }),
}))

const hasNoLeakingPiiDeep = jest.fn(
  (value: unknown) => !JSON.stringify(value).includes("leak@pii.example")
)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (...a: unknown[]) => hasNoLeakingPiiDeep(...(a as [unknown])),
}))

const PLUGIN = "conn-plugin"

describe("createConnectorsAPI", () => {
  let guard: ReturnType<typeof getPermissionGuard>

  beforeEach(() => {
    jest.clearAllMocks()
    inboundObservers.clear()
    callbackObservers.clear()
    runningEntries.clear()
    runningEntries.set(
      "lk",
      makeChatAdapter("lk", [
        "text",
        "chat.create",
        "chat.members",
        "chat.update",
        "contact.resolve",
      ])
    )
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
      expect(() => api.getA2UICapabilityMatrix("sl")).toThrow(PermissionError)
      expect(() => api.getSkillCapabilities("sl")).toThrow(PermissionError)
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
      expect(() => api.streamReply("tg", {} as never)).toThrow(PermissionError)
      expect(sendOutbound).not.toHaveBeenCalled()
      expect(streamReplyOutbound).not.toHaveBeenCalled()
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

    it("getA2UICapabilityMatrix forwards to the bus", () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(api.getA2UICapabilityMatrix("sl")).toEqual({ Button: "native", Card: "native" })
      expect(getAdapterA2UICapability).toHaveBeenCalledWith("sl")
      expect(api.getA2UICapabilityMatrix("nope")).toBeNull()
    })

    it("getSkillCapabilities forwards to the bus", () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(api.getSkillCapabilities("sl")).toEqual([
        { family: "lark.calendar", mutations: ["read", "write"] },
      ])
      expect(getAdapterSkillCapabilities).toHaveBeenCalledWith("sl")
      expect(api.getSkillCapabilities("nope")).toBeNull()
    })

    it("listInstances strips the keyring pointer", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const list = await api.listInstances()
      expect(list.map((r) => r.id)).toEqual(["cai_1", "cai_off"])
      expect(list[0].displayName).toBe("My Bot")
      for (const row of list) expect(row).not.toHaveProperty("credentialsRef")
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
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
      const api = createConnectorsAPI(PLUGIN)
      const req = { conversationRef: { x: 1 }, segments: [], metadata: { idempotencyKey: "k" } }
      const res = await api.send("tg", req as never)
      expect(res).toEqual({ ok: true, platformMessageId: "m1" })
      expect(sendOutbound).toHaveBeenCalledWith("tg", req)
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "delivery.legacy_direct" })
      )
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("enqueueSend"))
      warn.mockRestore()
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

    it("reaction / forward / pin / unpin / urgent forward to the bus", async () => {
      const api = createConnectorsAPI(PLUGIN)
      expect((await api.addReaction("tg", "pm_1", "OK")).reactionId).toBe("rx_1")
      expect(addReactionOutbound).toHaveBeenCalledWith("tg", "pm_1", "OK")
      expect((await api.removeReaction("tg", "pm_1", "rx_1")).ok).toBe(true)
      expect(removeReactionOutbound).toHaveBeenCalledWith("tg", "pm_1", "rx_1")
      expect((await api.forwardMessage("tg", { messageId: "pm_1", target: "c2" })).ok).toBe(true)
      expect(forwardOutbound).toHaveBeenCalledWith("tg", { messageId: "pm_1", target: "c2" })
      expect((await api.pinMessage("tg", "c1", "pm_1")).ok).toBe(true)
      expect(pinOutbound).toHaveBeenCalledWith("tg", "c1", "pm_1")
      expect((await api.unpinMessage("tg", "pm_1")).ok).toBe(true)
      expect(unpinOutbound).toHaveBeenCalledWith("tg", "pm_1")
      expect((await api.sendUrgent("tg", "pm_1", ["ou_a"], "app")).ok).toBe(true)
      expect(sendUrgentOutbound).toHaveBeenCalledWith("tg", "pm_1", ["ou_a"], "app")
    })

    it("getReadReceipt forwards to the bus (connectors:read)", async () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(await api.getReadReceipt("tg", "pm_1")).toEqual({ readers: [], hasMore: false })
      expect(getReadReceiptOutbound).toHaveBeenCalledWith("tg", "pm_1")
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

    it("streamReply forwards to the bus and returns its boolean", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const req = { conversationRef: { conv: "c1" }, text: "partial reply" }
      expect(await api.streamReply("sl", req as never)).toBe(true)
      expect(streamReplyOutbound).toHaveBeenCalledWith("sl", req)
    })
  })

  describe("a2ui builder (ungated)", () => {
    it("is usable with no permissions granted (pure construction)", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createConnectorsAPI(PLUGIN)
      const content = api.a2ui.surface({
        components: [api.a2ui.component.text("root", "Hello")],
      })
      expect(content.rootId).toBe("root")

      const seg = api.a2ui.segment("s1", content)
      expect(seg).toMatchObject({ type: "a2ui", surfaceId: "s1" })

      const req = api.a2ui.message({
        conversationRef: { conv: "c1" } as never,
        surfaceId: "s2",
        components: [
          api.a2ui.component.card("root", { title: "Hi", children: ["btn"] }),
          api.a2ui.component.button("btn", "Go", "go"),
        ],
      })
      expect(req.segments[0]).toMatchObject({ type: "a2ui", surfaceId: "s2" })
    })

    it("newIdempotencyKey is usable with no permissions and mints a key", () => {
      guard.registerPlugin(PLUGIN, [])
      const api = createConnectorsAPI(PLUGIN)
      expect(api.newIdempotencyKey()).toBe("idem-123")
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

  describe("multi-bot reads", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["connectors:read"]))

    it("gates the new read surfaces behind connectors:read", () => {
      resetPermissionGuard()
      guard = getPermissionGuard()
      guard.registerPlugin(PLUGIN, [])
      const api = createConnectorsAPI(PLUGIN)
      expect(() => api.listRunningAdapters()).toThrow(PermissionError)
      expect(() => api.findSessionByConversation("k")).toThrow(PermissionError)
      expect(() => api.listSiblingConversations("k")).toThrow(PermissionError)
      expect(() => api.getDispatchRules("cai_1")).toThrow(PermissionError)
      expect(() => api.previewAtGate("cai_1", {} as never)).toThrow(PermissionError)
    })

    it("listRunningAdapters returns live credential-free summaries", () => {
      const api = createConnectorsAPI(PLUGIN)
      const list = api.listRunningAdapters()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ id: "lk", type: "lark", displayName: "Chat lk" })
      expect(list[0]).not.toHaveProperty("send")
      expect(list[0]).not.toHaveProperty("createChat")
    })

    it("listEnabledInstances / listInstancesByType filter the stripped rows", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const enabled = await api.listEnabledInstances()
      expect(enabled.map((r) => r.id)).toEqual(["cai_1"])
      expect(enabled[0]).not.toHaveProperty("credentialsRef")
      const larks = await api.listInstancesByType("lark" as never)
      expect(larks.map((r) => r.id)).toEqual(["cai_off"])
      expect(larks[0]).not.toHaveProperty("credentialsRef")
    })

    it("findSessionByConversation returns a trimmed binding or null", async () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(await api.findSessionByConversation("telegram:tg:42")).toEqual({
        sessionId: "sess-1",
        title: "Group chat",
        conversationKey: "telegram:tg:42",
        characterId: "char-1",
        createdAt: 10,
        updatedAt: 20,
      })
      expect(await api.findSessionByConversation("missing")).toBeNull()
    })

    it("listSessionsByConversation trims every bound session", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const list = await api.listSessionsByConversation("telegram:tg:42")
      expect(list).toHaveLength(1)
      expect(list[0].sessionId).toBe("sess-1")
      expect(list[0]).not.toHaveProperty("platformBinding")
    })

    it("listSiblingConversations forwards to the binding layer", async () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(await api.listSiblingConversations("telegram:tg:42")).toEqual([
        { adapterId: "sl", conversationKey: "telegram:sl:42", sessionId: "sess-2" },
      ])
      expect(listSiblingConversationsMock).toHaveBeenCalledWith("telegram:tg:42")
    })

    it("getDispatchRules reads the instance rule table (empty default)", async () => {
      const api = createConnectorsAPI(PLUGIN)
      expect(await api.getDispatchRules("cai_rules")).toEqual([RULE])
      expect(await api.getDispatchRules("cai_1")).toEqual([])
      await expect(api.getDispatchRules("missing")).rejects.toThrow(/not found/)
    })

    it("previewDispatchRules dry-runs the matcher against the instance rules", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const event = { plainText: "deploy now", sender: { id: "u" }, channel: { kind: "group" } }
      const hit = await api.previewDispatchRules("cai_rules", event as never)
      expect(hit).toEqual({ rule: RULE, action: RULE.action })
      expect(matchDispatchRuleMock).toHaveBeenCalledWith([RULE], event)
    })

    it("previewAtGate dry-runs the guardrails against the instance row", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const event = { kind: "create" }
      expect(await api.previewAtGate("cai_1", event as never)).toEqual({
        allowed: false,
        reason: "chat_blocklist",
      })
      expect(shouldRespondToMessageMock).toHaveBeenCalledWith(event, INSTANCE_ROW)
      await expect(api.previewAtGate("missing", event as never)).rejects.toThrow(/not found/)
    })
  })

  describe("enqueueSend (durable queue)", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["connectors:send"]))

    it("is gated by connectors:send", () => {
      resetPermissionGuard()
      guard = getPermissionGuard()
      guard.registerPlugin(PLUGIN, ["connectors:read"])
      const api = createConnectorsAPI(PLUGIN)
      expect(() => api.enqueueSend("tg", "telegram:tg:42", {} as never)).toThrow(PermissionError)
      expect(enqueueOutbound).not.toHaveBeenCalled()
    })

    it("PII-gates the segments, then enqueues with source plugin", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const req = {
        conversationRef: { conv: "c1" },
        segments: [{ type: "text", text: "release is out" }],
        metadata: { idempotencyKey: "idem-9" },
      }
      const job = await api.enqueueSend("tg", "telegram:tg:42", req as never, {
        nextAttemptAt: 555,
      })
      expect(hasNoLeakingPiiDeep).toHaveBeenCalledWith(req.segments)
      expect(enqueueOutbound).toHaveBeenCalledWith({
        adapterId: "tg",
        conversationKey: "telegram:tg:42",
        request: req,
        source: "plugin",
        nextAttemptAt: 555,
      })
      expect(job).toEqual({
        jobId: "oqj_1",
        adapterId: "tg",
        conversationKey: "telegram:tg:42",
        status: "pending",
        nextAttemptAt: 100,
        idempotencyKey: "idem-9",
      })
    })

    it("rejects leaking payloads before anything reaches the queue", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const req = {
        conversationRef: { conv: "c1" },
        segments: [{ type: "text", text: "mail leak@pii.example" }],
        metadata: { idempotencyKey: "idem-9" },
      }
      await expect(api.enqueueSend("tg", "telegram:tg:42", req as never)).rejects.toThrow(
        /PII gate/
      )
      expect(enqueueOutbound).not.toHaveBeenCalled()
    })
  })

  describe("delivery feedback (getOutboundJob / waitForDelivery)", () => {
    const row = (status: string, extra: Record<string, unknown> = {}) => ({
      id: "oqj_9",
      adapterId: "tg",
      conversationKey: "telegram:tg:42",
      status,
      nextAttemptAt: 100,
      idempotencyKey: "idem-9",
      attempts: 1,
      ...extra,
    })

    beforeEach(() => guard.registerPlugin(PLUGIN, ["connectors:read"]))

    it("getOutboundJob returns null for an unknown id and a snapshot otherwise", async () => {
      const api = createConnectorsAPI(PLUGIN)
      outboundQueueGet.mockResolvedValueOnce(undefined)
      expect(await api.getOutboundJob("nope")).toBeNull()

      outboundQueueGet.mockResolvedValueOnce(
        row("sent", { platformMessageId: "pm_1", lastError: undefined })
      )
      const snap = await api.getOutboundJob("oqj_9")
      expect(snap).toMatchObject({
        jobId: "oqj_9",
        status: "sent",
        attempts: 1,
        platformMessageId: "pm_1",
      })
    })

    it("getOutboundJob surfaces the reroute pointer (F1 feedback link)", async () => {
      const api = createConnectorsAPI(PLUGIN)
      outboundQueueGet.mockResolvedValueOnce(
        row("deadlettered", { lastErrorCode: "balanced", reroutedToJobId: "oqj_sibling" })
      )
      const snap = await api.getOutboundJob("oqj_9")
      expect(snap?.reroutedToJobId).toBe("oqj_sibling")
    })

    it("waitForDelivery resolves immediately on an already-terminal job", async () => {
      const api = createConnectorsAPI(PLUGIN)
      outboundQueueGet.mockResolvedValueOnce(row("deadlettered", { lastErrorCode: "circuit_open" }))
      const snap = await api.waitForDelivery("oqj_9")
      expect(snap.status).toBe("deadlettered")
      expect(snap.lastErrorCode).toBe("circuit_open")
    })

    it("waitForDelivery rejects on an unknown job id", async () => {
      const api = createConnectorsAPI(PLUGIN)
      outboundQueueGet.mockResolvedValueOnce(undefined)
      await expect(api.waitForDelivery("nope")).rejects.toThrow(/unknown job/)
    })

    it("waitForDelivery resolves with the latest snapshot when the timeout elapses", async () => {
      const api = createConnectorsAPI(PLUGIN)
      // Initial read + the liveQuery querier both see a pending row.
      outboundQueueGet.mockResolvedValue(row("pending"))
      const snap = await api.waitForDelivery("oqj_9", { timeoutMs: 100 })
      expect(snap.status).toBe("pending")
    })
  })

  describe("chat management + routing management", () => {
    beforeEach(() => guard.registerPlugin(PLUGIN, ["connectors:manage"]))

    it("is gated by connectors:manage (send is insufficient)", () => {
      resetPermissionGuard()
      guard = getPermissionGuard()
      guard.registerPlugin(PLUGIN, ["connectors:read", "connectors:send"])
      const api = createConnectorsAPI(PLUGIN)
      expect(() => api.createChat("lk", {} as never)).toThrow(PermissionError)
      expect(() => api.resolveContacts("lk", {})).toThrow(PermissionError)
      expect(() => api.setDispatchRules("cai_1", [])).toThrow(PermissionError)
      expect(() => api.bootstrapConversation({} as never)).toThrow(PermissionError)
    })

    it("setDispatchRules validates the instance then replaces the table", async () => {
      const api = createConnectorsAPI(PLUGIN)
      await api.setDispatchRules("cai_1", [RULE] as never)
      expect(updateAdapterInstance).toHaveBeenCalledWith("cai_1", { dispatchRules: [RULE] })
      await expect(api.setDispatchRules("missing", [])).rejects.toThrow(/not found/)
      expect(updateAdapterInstance).toHaveBeenCalledTimes(1)
    })

    it("bootstrapConversation stamps plugin provenance", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const res = await api.bootstrapConversation({
        platform: "lark" as never,
        adapterId: "cai_1",
        remoteChatId: "oc_1",
        name: "Release war-room",
      })
      expect(res).toEqual({
        conversationKey: "lark:cai_1:oc_1",
        sessionId: "sess-boot",
        created: true,
      })
      expect(bootstrapConversationMock).toHaveBeenCalledWith({
        platform: "lark",
        adapterId: "cai_1",
        remoteChatId: "oc_1",
        name: "Release war-room",
        source: `plugin:${PLUGIN}`,
      })
    })

    it("createChat / updateChat / members / resolveContacts call the running adapter", async () => {
      const api = createConnectorsAPI(PLUGIN)
      const entry = runningEntries.get("lk")!
      expect(await api.createChat("lk", { name: "N", memberIds: ["ou_1"] })).toEqual({
        chatId: "oc_new",
      })
      expect(entry.adapter.createChat).toHaveBeenCalledWith({ name: "N", memberIds: ["ou_1"] })
      await api.updateChat("lk", { chatId: "oc_new", name: "N2" })
      expect(entry.adapter.updateChat).toHaveBeenCalledWith({ chatId: "oc_new", name: "N2" })
      expect(await api.addChatMembers("lk", { chatId: "oc_new", memberIds: ["u1"] })).toEqual({
        succeeded: ["u1"],
        failed: [],
      })
      expect(await api.removeChatMembers("lk", { chatId: "oc_new", memberIds: ["u1"] })).toEqual({
        succeeded: ["u1"],
        failed: [],
      })
      expect(await api.resolveContacts("lk", { emails: ["a@b.c"] })).toEqual([
        { memberId: "ou_1", displayName: "Ann", confidence: "exact" },
      ])
    })

    it("rejects when the adapter is not running / unhealthy / incapable / method-less", async () => {
      const api = createConnectorsAPI(PLUGIN)
      await expect(api.createChat("ghost", { name: "N", memberIds: [] })).rejects.toThrow(
        /not running/
      )

      const sick = makeChatAdapter("sick", ["chat.create"])
      sick.adapter.health.mockReturnValue({ state: "error" } as never)
      runningEntries.set("sick", sick)
      await expect(api.createChat("sick", { name: "N", memberIds: [] })).rejects.toThrow(
        /not healthy/
      )

      runningEntries.set("nocap", makeChatAdapter("nocap", ["text"]))
      await expect(api.createChat("nocap", { name: "N", memberIds: [] })).rejects.toThrow(
        /required capabilities: chat.create/
      )

      runningEntries.set("buggy", makeChatAdapter("buggy", ["chat.create"], false))
      await expect(api.createChat("buggy", { name: "N", memberIds: [] })).rejects.toThrow(
        /does not implement createChat/
      )
    })
  })
})
