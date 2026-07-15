/** @jest-environment jsdom */
import {
  PluginConsentBroker,
  PLUGIN_CONSENT_REQUEST_EVENT,
  type PluginConsentRequestEvent,
  getPluginConsentBroker,
  resetPluginConsentBroker,
} from "./consent-broker"

describe("PluginConsentBroker", () => {
  let captured: PluginConsentRequestEvent[]
  let broker: PluginConsentBroker

  beforeEach(() => {
    captured = []
    broker = new PluginConsentBroker({
      timeoutMs: 200,
      emit: (event) => captured.push(event),
    })
  })

  afterEach(() => {
    broker.rejectAllPending()
    broker.clearAllSessionGrants()
  })

  it("emits a consent-request event on first call", async () => {
    const promise = broker.request({ pluginId: "p1", permission: "shell:execute" })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual(
      expect.objectContaining({
        pluginId: "p1",
        permission: "shell:execute",
        requestId: expect.any(String),
        timeoutMs: 200,
      })
    )
    const reqId = captured[0].requestId
    broker.respond(reqId, { allow: true, persist: false })
    await expect(promise).resolves.toBe(true)
  })

  it("resolves false when the user rejects", async () => {
    const promise = broker.request({ pluginId: "p1", permission: "filesystem:write" })
    broker.respond(captured[0].requestId, { allow: false, persist: false })
    await expect(promise).resolves.toBe(false)
  })

  it("auto-rejects after the configured timeout", async () => {
    const result = await broker.request({ pluginId: "p1", permission: "clipboard:read" })
    expect(result).toBe(false)
  })

  it("persists 'Always allow this session' and skips the overlay next time", async () => {
    const first = broker.request({ pluginId: "p1", permission: "shell:execute" })
    broker.respond(captured[0].requestId, { allow: true, persist: true })
    await expect(first).resolves.toBe(true)

    // Second call should resolve immediately without emitting a new event.
    captured.length = 0
    const second = await broker.request({ pluginId: "p1", permission: "shell:execute" })
    expect(second).toBe(true)
    expect(captured).toHaveLength(0)
    expect(broker.hasSessionGrant("p1", "shell:execute")).toBe(true)
  })

  it("respond is idempotent — double-respond resolves once", async () => {
    const promise = broker.request({ pluginId: "p1", permission: "shell:execute" })
    const reqId = captured[0].requestId
    expect(broker.respond(reqId, { allow: true, persist: false })).toBe(true)
    expect(broker.respond(reqId, { allow: false, persist: false })).toBe(false)
    await expect(promise).resolves.toBe(true)
  })

  it("clearSessionGrantsForPlugin only removes the targeted plugin's grants", async () => {
    const a = broker.request({ pluginId: "a", permission: "shell:execute" })
    broker.respond(captured[0].requestId, { allow: true, persist: true })
    await expect(a).resolves.toBe(true)
    const b = broker.request({ pluginId: "b", permission: "shell:execute" })
    broker.respond(captured[1].requestId, { allow: true, persist: true })
    await expect(b).resolves.toBe(true)
    expect(broker.hasSessionGrant("a", "shell:execute")).toBe(true)
    expect(broker.hasSessionGrant("b", "shell:execute")).toBe(true)
    broker.clearSessionGrantsForPlugin("a")
    expect(broker.hasSessionGrant("a", "shell:execute")).toBe(false)
    expect(broker.hasSessionGrant("b", "shell:execute")).toBe(true)
  })

  it("rejectAllPending resolves every outstanding request as denied", async () => {
    const p1 = broker.request({ pluginId: "a", permission: "shell:execute" })
    const p2 = broker.request({ pluginId: "b", permission: "filesystem:write" })
    expect(broker.pendingCount()).toBe(2)
    broker.rejectAllPending()
    expect(broker.pendingCount()).toBe(0)
    await expect(p1).resolves.toBe(false)
    await expect(p2).resolves.toBe(false)
  })

  it("falls back to auto-reject if the emit fails", async () => {
    const failing = new PluginConsentBroker({
      timeoutMs: 5000,
      emit: () => {
        throw new Error("emit broken")
      },
    })
    const result = await failing.request({ pluginId: "p1", permission: "shell:execute" })
    expect(result).toBe(false)
  })

  it("defaults to dispatching a window CustomEvent when no emit override is provided", async () => {
    const realBroker = new PluginConsentBroker({ timeoutMs: 50 })
    const seen: PluginConsentRequestEvent[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent<PluginConsentRequestEvent>).detail)
    window.addEventListener(PLUGIN_CONSENT_REQUEST_EVENT, listener)
    const promise = realBroker.request({ pluginId: "p1", permission: "shell:execute" })
    expect(seen).toHaveLength(1)
    realBroker.respond(seen[0].requestId, { allow: false, persist: false })
    await expect(promise).resolves.toBe(false)
    window.removeEventListener(PLUGIN_CONSENT_REQUEST_EVENT, listener)
  })
})

describe("PluginConsentBroker.requestBinary", () => {
  let captured: PluginConsentRequestEvent[]
  let broker: PluginConsentBroker

  const BINARY = { path: "/plugins/acme/bin/tool", relPath: "bin/tool" }
  const REQ = { pluginId: "acme", permission: "cli:execute" as const, binary: BINARY }

  beforeEach(() => {
    captured = []
    broker = new PluginConsentBroker({ timeoutMs: 200, emit: (event) => captured.push(event) })
  })

  afterEach(() => {
    broker.rejectAllPending()
    broker.clearAllSessionGrants()
  })

  it("carries the binary subject on the emitted event so the overlay can offer the checkbox", async () => {
    const promise = broker.requestBinary(REQ)
    expect(captured[0]).toEqual(expect.objectContaining({ binary: BINARY }))
    broker.respond(captured[0].requestId, { allow: true, persist: false })
    await expect(promise).resolves.toEqual({ granted: true, remember: false })
  })

  it("returns remember:true only when the responder says so explicitly", async () => {
    const promise = broker.requestBinary(REQ)
    broker.respond(captured[0].requestId, { allow: true, persist: false, remember: true })
    await expect(promise).resolves.toEqual({ granted: true, remember: true })
  })

  it("treats an omitted remember field as session-scoped", async () => {
    // Every responder written before `remember` existed — including the global
    // test auto-responder — omits it. Omission must never mean "durable".
    const promise = broker.requestBinary(REQ)
    broker.respond(captured[0].requestId, { allow: true, persist: false })
    await expect(promise).resolves.toEqual({ granted: true, remember: false })
  })

  it("strips remember from a rejection", async () => {
    const promise = broker.requestBinary(REQ)
    broker.respond(captured[0].requestId, { allow: false, persist: false, remember: true })
    await expect(promise).resolves.toEqual({ granted: false, remember: false })
  })

  it("never infers remember from a session grant — no prompt means no answer", async () => {
    // A session grant short-circuits the prompt entirely, so the user was never
    // asked about durability. Inferring it from their earlier "allow this
    // session" is exactly the silent upgrade the ledger must not permit.
    const first = broker.requestBinary(REQ)
    broker.respond(captured[0].requestId, { allow: true, persist: true, remember: true })
    await expect(first).resolves.toEqual({ granted: true, remember: true })

    captured.length = 0
    await expect(broker.requestBinary(REQ)).resolves.toEqual({ granted: true, remember: false })
    expect(captured).toHaveLength(0)
  })

  it("auto-rejects on timeout without remembering", async () => {
    await expect(broker.requestBinary(REQ)).resolves.toEqual({ granted: false, remember: false })
  })

  it("auto-rejects without remembering when the emit fails", async () => {
    const failing = new PluginConsentBroker({
      timeoutMs: 5000,
      emit: () => {
        throw new Error("emit broken")
      },
    })
    await expect(failing.requestBinary(REQ)).resolves.toEqual({ granted: false, remember: false })
  })

  it("rejectAllPending denies an outstanding binary request without remembering", async () => {
    const promise = broker.requestBinary(REQ)
    broker.rejectAllPending()
    await expect(promise).resolves.toEqual({ granted: false, remember: false })
  })
})

describe("getPluginConsentBroker singleton", () => {
  afterEach(() => {
    resetPluginConsentBroker()
  })

  it("returns the same instance until reset", () => {
    const a = getPluginConsentBroker()
    const b = getPluginConsentBroker()
    expect(a).toBe(b)
    resetPluginConsentBroker()
    const c = getPluginConsentBroker()
    expect(c).not.toBe(a)
  })
})
