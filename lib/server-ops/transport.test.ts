import type { OperationEvent } from "./client"

const mockDetectPlatform = jest.fn<string, []>()
const mockGetCapacitorHttp = jest.fn<{ request: jest.Mock } | null, []>()
const mockProxyFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit | undefined]>()
const mockInvoke = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>()
const mockListen = jest.fn<Promise<() => void>, [string, (event: { payload: unknown }) => void]>()

jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => mockDetectPlatform(),
}))
jest.mock("@/lib/connectivity/capacitor-http", () => ({
  getCapacitorHttp: () => mockGetCapacitorHttp(),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({
  createProxyFetch: () => mockProxyFetch,
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => mockInvoke(command, args),
}))
jest.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) =>
    mockListen(name, handler),
}))

import {
  createOpsEventStream,
  createOpsFetch,
  opsTransportKind,
  supportsLiveOperationEvents,
} from "./transport"

/** Deliver a payload to whichever handler the stream registered. */
function emit(payload: unknown): void {
  const handler = mockListen.mock.calls.at(-1)?.[1]
  if (!handler) throw new Error("no listener registered")
  handler({ payload })
}

const operationEvent: OperationEvent = {
  id: 7,
  operationId: "op-1",
  targetId: "staging",
  state: "executing",
  timestamp: "2026-08-19T10:00:00Z",
  message: "operation executing",
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDetectPlatform.mockReturnValue("web")
  mockGetCapacitorHttp.mockReturnValue(null)
  mockListen.mockResolvedValue(() => {})
  mockInvoke.mockResolvedValue(undefined)
})

describe("opsTransportKind", () => {
  it("routes desktop through the native bridge and plain web through fetch", () => {
    mockDetectPlatform.mockReturnValue("tauri")
    expect(opsTransportKind()).toBe("tauri")
    expect(supportsLiveOperationEvents()).toBe(true)

    mockDetectPlatform.mockReturnValue("web")
    expect(opsTransportKind()).toBe("browser")
    // The web shell can only reach a controller that opts into CORS, and it
    // cannot hold a stream open through a buffered bridge either.
    expect(supportsLiveOperationEvents()).toBe(false)
  })

  it("requires the native plugin, not just a mobile shell, for the Capacitor path", () => {
    mockDetectPlatform.mockReturnValue("mobile")
    // A mobile *web* build reports `mobile` without the native HTTP plugin;
    // claiming the Capacitor transport there would route through a bridge that
    // does not exist.
    expect(opsTransportKind()).toBe("browser")

    mockGetCapacitorHttp.mockReturnValue({ request: jest.fn() })
    expect(opsTransportKind()).toBe("capacitor")
    expect(supportsLiveOperationEvents()).toBe(false)
  })
})

describe("createOpsFetch", () => {
  it("sends desktop traffic through the proxy bridge rather than the WebView", async () => {
    mockDetectPlatform.mockReturnValue("tauri")
    mockProxyFetch.mockResolvedValue(new Response("{}", { status: 200 }))

    const response = await createOpsFetch()("https://ops.example.com/v1/servers", {
      headers: { authorization: "Bearer token" },
    })

    expect(response.status).toBe(200)
    expect(mockProxyFetch).toHaveBeenCalledTimes(1)
  })

  it("maps a CapacitorHttp response onto a fetch Response", async () => {
    const request = jest.fn().mockResolvedValue({
      status: 202,
      headers: { "content-type": "application/json" },
      data: '{"id":"op-1"}',
      url: "https://ops.example.com/v1/servers/staging/backups",
    })
    mockDetectPlatform.mockReturnValue("mobile")
    mockGetCapacitorHttp.mockReturnValue({ request })

    const response = await createOpsFetch()("https://ops.example.com/v1/servers/staging/backups", {
      method: "POST",
      headers: { "idempotency-key": "backup-1" },
      body: "{}",
    })

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ id: "op-1" })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        data: "{}",
        responseType: "text",
        headers: expect.objectContaining({ "idempotency-key": "backup-1" }),
      })
    )
  })

  it("keeps a 204 body-less so the Response constructor does not throw", async () => {
    // An empty string is still a body, and `new Response("", {status: 204})`
    // throws — which surfaced as an opaque transport failure rather than a
    // successful no-content mutation.
    const request = jest.fn().mockResolvedValue({ status: 204, headers: {}, data: "", url: "" })
    mockDetectPlatform.mockReturnValue("mobile")
    mockGetCapacitorHttp.mockReturnValue({ request })

    const response = await createOpsFetch()("https://ops.example.com/v1/servers", {
      method: "POST",
      body: "{}",
    })
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })
})

describe("createOpsEventStream", () => {
  const streamOptions = {
    controllerUrl: "https://ops.example.com",
    accessToken: () => Promise.resolve("access-token"),
  }

  it("is unavailable wherever the transport is buffered", () => {
    mockDetectPlatform.mockReturnValue("web")
    expect(createOpsEventStream(streamOptions)).toBeNull()
  })

  it("yields decoded operation events and stops when the native task closes", async () => {
    mockDetectPlatform.mockReturnValue("tauri")
    const stream = createOpsEventStream(streamOptions)
    if (!stream) throw new Error("expected a desktop stream")

    const controller = new AbortController()
    const seen: OperationEvent[] = []
    const consumed = (async () => {
      for await (const event of stream({ lastEventId: 6, signal: controller.signal })) {
        seen.push(event)
      }
    })()

    await jest.requireActual<typeof import("timers/promises")>("timers/promises").setImmediate()
    expect(mockInvoke).toHaveBeenCalledWith(
      "server_ops_events_open",
      expect.objectContaining({
        controllerUrl: "https://ops.example.com",
        accessToken: "access-token",
        // The cursor crosses as a string: the native side forwards it verbatim
        // as the `Last-Event-ID` header.
        lastEventId: "6",
      })
    )

    emit({ kind: "open" })
    emit({ kind: "event", id: "7", event: "operation", data: JSON.stringify(operationEvent) })
    // A controller-side storage blip is not an operation event and must not be
    // mistaken for one — nor end the stream.
    emit({ kind: "event", id: null, event: "controller-error", data: '{"code":"unavailable"}' })
    emit({ kind: "event", id: "8", event: "operation", data: "{not json" })
    emit({ kind: "closed", error: null })

    await consumed
    expect(seen).toEqual([operationEvent])
    expect(mockInvoke).toHaveBeenCalledWith("server_ops_events_close", expect.anything())
  })

  it("throws a typed error when the native task reports a failure", async () => {
    mockDetectPlatform.mockReturnValue("tauri")
    const stream = createOpsEventStream(streamOptions)
    if (!stream) throw new Error("expected a desktop stream")

    const controller = new AbortController()
    const consumed = (async () => {
      for await (const _event of stream({ signal: controller.signal })) {
        // Drained for its errors, not its events.
      }
    })()

    await jest.requireActual<typeof import("timers/promises")>("timers/promises").setImmediate()
    emit({ kind: "closed", error: "controller returned 403: insufficient_scope" })

    // The reconnect loop needs the controller's own code to tell an expired
    // token apart from an unreachable host.
    await expect(consumed).rejects.toThrow("insufficient_scope")
  })

  it("refuses to open a stream without an access token", async () => {
    mockDetectPlatform.mockReturnValue("tauri")
    const stream = createOpsEventStream({
      controllerUrl: "https://ops.example.com",
      accessToken: () => Promise.resolve(""),
    })
    if (!stream) throw new Error("expected a desktop stream")

    const controller = new AbortController()
    await expect(
      (async () => {
        for await (const _event of stream({ signal: controller.signal })) {
          // Never reached.
        }
      })()
    ).rejects.toThrow("Authentication is required")
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("closes the native stream when the consumer aborts", async () => {
    mockDetectPlatform.mockReturnValue("tauri")
    const unlisten = jest.fn()
    mockListen.mockResolvedValue(unlisten)
    const stream = createOpsEventStream(streamOptions)
    if (!stream) throw new Error("expected a desktop stream")

    const controller = new AbortController()
    const consumed = (async () => {
      for await (const _event of stream({ signal: controller.signal })) {
        // Never reached: the abort lands before any event does.
      }
    })()

    await jest.requireActual<typeof import("timers/promises")>("timers/promises").setImmediate()
    controller.abort()
    await consumed

    expect(unlisten).toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledWith("server_ops_events_close", expect.anything())
  })
})
