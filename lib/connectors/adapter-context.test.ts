/**
 * Coverage for the production `AdapterContext` factory.
 *
 * Verifies the wired Tauri command shims, the bus.emit pass-through,
 * and that the helper is shape-compatible with the
 * `AdapterContext` interface adapters implement against.
 */

import { invoke } from "@tauri-apps/api/core"
import { buildAdapterContext } from "./adapter-context"
import type { ConnectorBus } from "./bus"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

const mockInvoke = invoke as jest.Mock

describe("buildAdapterContext", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  function makeBus(): ConnectorBus {
    const dispatched: NormalizedInboundEvent[] = []
    const bus = {
      dispatchInboundFull: jest.fn(async (event: NormalizedInboundEvent) => {
        dispatched.push(event)
      }),
    } as unknown as ConnectorBus
    ;(bus as unknown as { __dispatched: NormalizedInboundEvent[] }).__dispatched = dispatched
    return bus
  }

  function makeEvent(): NormalizedInboundEvent {
    return {
      platform: "lark",
      adapterId: "lark-1",
      selfId: "bot",
      messageId: "om_1",
      conversationRef: { platform: "lark", adapterId: "lark-1", chatId: "oc_x" },
      conversationKey: "lark:lark-1:oc_x",
      sender: {
        id: "lark:lark-1:ou_y",
        platform: "lark",
        adapterId: "lark-1",
        remoteUserId: "ou_y",
      },
      channel: { id: "oc_x", kind: "group" },
      segments: [{ type: "text", text: "hi" }],
      plainText: "hi",
      mentions: { selfMentioned: true, users: [] },
      timestamp: 0,
      raw: {},
    }
  }

  it("emit routes events through bus.dispatchInboundFull", async () => {
    const bus = makeBus()
    const ac = new AbortController()
    const ctx = buildAdapterContext({
      adapterId: "lark-1",
      signal: ac.signal,
      bus,
    })
    const event = makeEvent()
    await ctx.emit(event)
    expect(
      (bus as unknown as { dispatchInboundFull: jest.Mock }).dispatchInboundFull
    ).toHaveBeenCalledWith(event)
  })

  it("adapterId + signal pass through verbatim", () => {
    const bus = makeBus()
    const ac = new AbortController()
    const ctx = buildAdapterContext({
      adapterId: "lark-2",
      signal: ac.signal,
      bus,
    })
    expect(ctx.adapterId).toBe("lark-2")
    expect(ctx.signal).toBe(ac.signal)
  })

  it("publicBaseUrl returns the row URL when supplied", async () => {
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-3",
      signal: new AbortController().signal,
      bus,
      publicUrl: "https://example.com/lark",
    })
    expect(await ctx.tauri.publicBaseUrl()).toBe("https://example.com/lark")
  })

  it("publicBaseUrl returns null when no row URL is configured", async () => {
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-4",
      signal: new AbortController().signal,
      bus,
    })
    expect(await ctx.tauri.publicBaseUrl()).toBeNull()
  })

  it("httpRequest delegates to connectors_http_request", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, headers: {}, body: "{}" })
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-5",
      signal: new AbortController().signal,
      bus,
    })
    const resp = await ctx.tauri.httpRequest({ url: "https://x/y", method: "GET" })
    expect(resp.status).toBe(200)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_http_request", {
      req: { url: "https://x/y", method: "GET" },
    })
  })

  it("openWs builds a TauriWsHandle wired to send/close commands", async () => {
    mockInvoke
      .mockResolvedValueOnce("ws-handle-1") // open
      .mockResolvedValueOnce(undefined) // send
      .mockResolvedValueOnce(undefined) // close
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-6",
      signal: new AbortController().signal,
      bus,
    })
    const handle = await ctx.tauri.openWs({ url: "wss://x" })
    expect(handle.id).toBe("ws-handle-1")
    await handle.send("hello")
    await handle.close()
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "connectors_ws_open", {
      url: "wss://x",
      headers: undefined,
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "connectors_ws_send", {
      handleId: "ws-handle-1",
      data: "hello",
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "connectors_ws_close", {
      handleId: "ws-handle-1",
    })
  })

  it("fetchAttachment returns a cache handle, never a path to plaintext", async () => {
    const cacheKey = "a".repeat(64)
    mockInvoke.mockResolvedValueOnce({
      cacheKey,
      remoteRef: "rr-1",
      sizeBytes: 128,
      createdAt: 1,
      lastAccessedAt: 1,
      cached: false,
    })
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-7",
      signal: new AbortController().signal,
      bus,
    })
    const ref = await ctx.tauri.fetchAttachment("lark-7", "rr-1")
    // The cache holds ciphertext only — an adapter that treated `localUrl` as
    // a readable file would be reading a file that no longer exists.
    expect(ref).toEqual({
      localUrl: `cognia-attachment:${cacheKey}`,
      remoteRef: "rr-1",
      cacheKey,
    })
    expect(mockInvoke).toHaveBeenCalledWith("connectors_attachment_fetch", {
      adapterId: "lark-7",
      remoteRef: "rr-1",
      sourceUrl: "rr-1",
      headers: undefined,
      ttlMs: undefined,
    })
  })

  it("secrets.get/set/delete/list wrap the keyring commands", async () => {
    mockInvoke
      .mockResolvedValueOnce("the-value") // get
      .mockResolvedValueOnce(undefined) // set
      .mockResolvedValueOnce(undefined) // delete
      .mockResolvedValueOnce(["a", "b"]) // list
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-8",
      signal: new AbortController().signal,
      bus,
    })
    expect(await ctx.secrets.get("appSecret")).toBe("the-value")
    await ctx.secrets.set("appSecret", "v")
    await ctx.secrets.delete("appSecret")
    expect(await ctx.secrets.list()).toEqual(["a", "b"])
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "connectors_keyring_get", {
      adapterId: "lark-8",
      credential: "appSecret",
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "connectors_keyring_set", {
      adapterId: "lark-8",
      credential: "appSecret",
      value: "v",
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "connectors_keyring_delete", {
      adapterId: "lark-8",
      credential: "appSecret",
    })
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "connectors_keyring_list", {
      adapterId: "lark-8",
      accounts: [],
    })
  })

  it("logger writes prefixed messages to console", () => {
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-9",
      signal: new AbortController().signal,
      bus,
    })
    const debug = jest.spyOn(console, "debug").mockImplementation(() => {})
    const info = jest.spyOn(console, "info").mockImplementation(() => {})
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    ctx.logger.debug("d", { a: 1 })
    ctx.logger.info("i")
    ctx.logger.warn("w", { x: "y" })
    ctx.logger.error("e")
    expect(debug).toHaveBeenCalledWith("[adapter:lark-9]", "d", { a: 1 })
    expect(info).toHaveBeenCalledWith("[adapter:lark-9]", "i", {})
    expect(warn).toHaveBeenCalledWith("[adapter:lark-9]", "w", { x: "y" })
    expect(error).toHaveBeenCalledWith("[adapter:lark-9]", "e", {})
    debug.mockRestore()
    info.mockRestore()
    warn.mockRestore()
    error.mockRestore()
  })

  // No adapter registers a per-adapter HTTP route in v1, and the underlying
  // `connectors_bind_webhook_route` Rust command does not exist. These now
  // throw a clear, self-documenting error (via `notImplemented`) rather than
  // firing a phantom `invoke` that would surface an opaque "command not found".
  it("bindWebhookRoute throws a self-documenting error and never invokes a phantom command", () => {
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-a",
      signal: new AbortController().signal,
      bus,
    })
    expect(() => ctx.tauri.bindWebhookRoute("lark-a", "/lark-webhook")).toThrow(
      /bindWebhookRoute is not wired/
    )
    expect(mockInvoke).not.toHaveBeenCalledWith("connectors_bind_webhook_route", expect.anything())
  })

  it("unbindWebhookRoute throws a self-documenting error and never invokes a phantom command", () => {
    const bus = makeBus()
    const ctx = buildAdapterContext({
      adapterId: "lark-b",
      signal: new AbortController().signal,
      bus,
    })
    expect(() => ctx.tauri.unbindWebhookRoute("lark-b", "/lark-webhook")).toThrow(
      /unbindWebhookRoute is not wired/
    )
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "connectors_unbind_webhook_route",
      expect.anything()
    )
  })
})
