/**
 * @jest-environment node
 */

const mockAiGenerateText = jest.fn()
const mockWorkflowEmitEvent = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@tauri-apps/api/event", () => ({ listen: jest.fn() }))
jest.mock("./handlers/ai-generate-text", () => ({
  aiGenerateText: (...args: unknown[]) => mockAiGenerateText(...(args as [])),
}))
jest.mock("./handlers/workflow-emit-event", () => ({
  workflowEmitEvent: (...args: unknown[]) => mockWorkflowEmitEvent(...(args as [])),
}))

import {
  WASM_RENDERER_CANCEL_EVENT,
  WASM_RENDERER_REQUEST_EVENT,
  WASM_RENDERER_RESPONSE_COMMAND,
} from "./protocol"
import { __resetWasmRequestRegistryForTesting, pendingCount } from "./request-registry"
import { installWasmRendererRequestSource } from "./renderer-request-source"

type Handler = (e: { payload: unknown }) => void

function makeBridge() {
  const listeners = new Map<string, Handler>()
  const unlistened: string[] = []
  const invocations: Array<{ name: string; args: Record<string, unknown> }> = []
  return {
    listeners,
    unlistened,
    invocations,
    responses: () =>
      invocations
        .filter((i) => i.name === WASM_RENDERER_RESPONSE_COMMAND)
        .map((i) => i.args.response as Record<string, unknown>),
    emit(event: string, payload: unknown) {
      listeners.get(event)?.({ payload })
    },
    bridge: {
      listen: async <T>(event: string, handler: (e: { payload: T }) => void) => {
        listeners.set(event, handler as Handler)
        return () => {
          unlistened.push(event)
          listeners.delete(event)
        }
      },
      invoke: async (name: string, args: Record<string, unknown>) => {
        invocations.push({ name, args })
        return undefined
      },
    },
  }
}

const request = (over: Record<string, unknown> = {}) => ({
  requestId: "req-1",
  pluginId: "p",
  operation: "ai.generate-text",
  timeoutMs: 30_000,
  payload: { messages: [{ role: "user", content: "hi" }] },
  ...over,
})

/** Let the listener's floating promise chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  jest.clearAllMocks()
  __resetWasmRequestRegistryForTesting()
  mockAiGenerateText.mockResolvedValue({ text: "generated" })
  mockWorkflowEmitEvent.mockResolvedValue({ ok: true, prefixedKind: "p:tick" })
})

afterEach(() => {
  __resetWasmRequestRegistryForTesting()
})

describe("install", () => {
  it("subscribes to both the request and cancel channels", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })
    expect([...h.listeners.keys()].sort()).toEqual(
      [WASM_RENDERER_CANCEL_EVENT, WASM_RENDERER_REQUEST_EVENT].sort()
    )
  })

  it("is guarded against double installation", async () => {
    const first = makeBridge()
    await installWasmRendererRequestSource({ bridge: first.bridge, forceReinstall: true })
    const second = makeBridge()
    await installWasmRendererRequestSource({ bridge: second.bridge })
    expect(second.listeners.size).toBe(0)
  })

  it("teardown unlistens both channels", async () => {
    const h = makeBridge()
    const teardown = await installWasmRendererRequestSource({
      bridge: h.bridge,
      forceReinstall: true,
    })
    teardown()
    expect(h.unlistened.sort()).toEqual(
      [WASM_RENDERER_CANCEL_EVENT, WASM_RENDERER_REQUEST_EVENT].sort()
    )
  })

  it("teardown aborts outstanding requests so nothing leaks", async () => {
    const h = makeBridge()
    const teardown = await installWasmRendererRequestSource({
      bridge: h.bridge,
      forceReinstall: true,
    })
    let release: (v: unknown) => void = () => {}
    mockAiGenerateText.mockImplementation(() => new Promise((r) => (release = r)))

    h.emit(WASM_RENDERER_REQUEST_EVENT, request())
    await flush()
    expect(pendingCount()).toBe(1)

    teardown()
    release({ text: "late" })
    await flush()
    // The late result is discarded, and no second response is sent.
    expect(h.responses()).toHaveLength(0)
  })
})

describe("request dispatch", () => {
  it("answers a valid AI request with exactly one response", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })

    h.emit(WASM_RENDERER_REQUEST_EVENT, request())
    await flush()

    const responses = h.responses()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      requestId: "req-1",
      pluginId: "p",
      result: { text: "generated" },
    })
    expect(pendingCount()).toBe(0)
  })

  it("routes workflow requests to the workflow handler", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })

    h.emit(
      WASM_RENDERER_REQUEST_EVENT,
      request({ operation: "workflow.emit-event", payload: { workflowId: "wf", kind: "t" } })
    )
    await flush()

    expect(mockWorkflowEmitEvent).toHaveBeenCalledTimes(1)
    expect(mockAiGenerateText).not.toHaveBeenCalled()
    expect(h.responses()[0]).toMatchObject({ result: { ok: true } })
  })

  it("answers an unknown operation with INVALID_REQUEST instead of hanging", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })

    h.emit(WASM_RENDERER_REQUEST_EVENT, request({ operation: "fs.delete-everything" }))
    await flush()

    expect(h.responses()[0]).toMatchObject({
      requestId: "req-1",
      error: { code: "INVALID_REQUEST" },
    })
  })

  it("drops a frame with no identifiable requestId", async () => {
    // Nothing to answer to — replying would need an id we do not have.
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })

    h.emit(WASM_RENDERER_REQUEST_EVENT, { operation: "ai.generate-text" })
    await flush()

    expect(h.responses()).toHaveLength(0)
  })

  it("rejects a duplicate requestId without disturbing the live request", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })
    let release: (v: unknown) => void = () => {}
    mockAiGenerateText.mockImplementationOnce(() => new Promise((r) => (release = r)))

    h.emit(WASM_RENDERER_REQUEST_EVENT, request())
    await flush()
    h.emit(WASM_RENDERER_REQUEST_EVENT, request())
    await flush()

    expect(h.responses()).toHaveLength(1)
    expect(h.responses()[0]).toMatchObject({ error: { code: "INVALID_REQUEST" } })

    release({ text: "original" })
    await flush()
    expect(h.responses()[1]).toMatchObject({ result: { text: "original" } })
  })

  it("maps a handler throw through the error table", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })
    mockAiGenerateText.mockRejectedValue(new Error("upstream exploded"))

    h.emit(WASM_RENDERER_REQUEST_EVENT, request())
    await flush()

    expect(h.responses()[0]).toMatchObject({
      error: { code: "PROVIDER_ERROR", message: "upstream exploded" },
    })
  })
})

describe("cancellation", () => {
  it("answers once with CANCELLED and discards the late handler result", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })

    let release: (v: unknown) => void = () => {}
    mockAiGenerateText.mockImplementation(
      (_id: string, _payload: unknown, signal: AbortSignal) =>
        new Promise((resolve, reject) => {
          release = resolve
          signal.addEventListener("abort", () => {
            const err = new Error("aborted")
            err.name = "AbortError"
            reject(err)
          })
        })
    )

    h.emit(WASM_RENDERER_REQUEST_EVENT, request())
    await flush()

    h.emit(WASM_RENDERER_CANCEL_EVENT, {
      requestId: "req-1",
      pluginId: "p",
      reason: "deactivate",
    })
    await flush()

    expect(h.responses()).toHaveLength(1)
    expect(h.responses()[0]).toMatchObject({ error: { code: "CANCELLED" } })

    // The handler's own late resolution must produce no second response.
    release({ text: "too late" })
    await flush()
    expect(h.responses()).toHaveLength(1)
  })

  it("classifies a timeout cancel as TIMEOUT, not CANCELLED", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })
    mockAiGenerateText.mockImplementation(
      (_id: string, _payload: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted")
            err.name = "AbortError"
            reject(err)
          })
        })
    )

    h.emit(WASM_RENDERER_REQUEST_EVENT, request())
    await flush()
    h.emit(WASM_RENDERER_CANCEL_EVENT, {
      requestId: "req-1",
      pluginId: "p",
      reason: "timeout",
    })
    await flush()

    expect(h.responses()[0]).toMatchObject({ error: { code: "TIMEOUT" } })
  })

  it("ignores a malformed cancel frame", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })
    expect(() => h.emit(WASM_RENDERER_CANCEL_EVENT, { pluginId: "p" })).not.toThrow()
  })

  it("ignores a cancel for an unknown request", async () => {
    const h = makeBridge()
    await installWasmRendererRequestSource({ bridge: h.bridge, forceReinstall: true })
    h.emit(WASM_RENDERER_CANCEL_EVENT, {
      requestId: "ghost",
      pluginId: "p",
      reason: "caller",
    })
    await flush()
    expect(h.responses()).toHaveLength(0)
  })
})

describe("host resilience", () => {
  it("survives a failing response invoke rather than throwing inside the listener", async () => {
    // An unhandled rejection inside an event listener would take down the
    // whole bridge; the request just expires on the Rust timeout instead.
    const h = makeBridge()
    const failing = {
      ...h.bridge,
      invoke: async () => {
        throw new Error("command not registered")
      },
    }
    await installWasmRendererRequestSource({ bridge: failing, forceReinstall: true })

    h.emit(WASM_RENDERER_REQUEST_EVENT, request())
    await flush()
    // Settled and removed despite the invoke failing — no leak, no throw.
    expect(pendingCount()).toBe(0)
  })
})
