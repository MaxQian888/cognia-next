// Tests for the live session-control round-trip (`sessionControl` + the typed
// wrappers). Drives the singleton `control_response` listener by capturing the
// handler passed to `transport.subscribe` and feeding it synthetic events.

import { transport } from "@/lib/tauri"
import {
  getSessionContextUsage,
  getSessionMcpStatus,
  reconnectSessionMcpServer,
  sessionControl,
  setSessionModel,
} from "./ipc"

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// The control listener is a module singleton — it subscribes exactly once, so
// `captured` is set on the first `sessionControl` call and stays valid for the
// rest of the suite (the same closure is reused).
let captured: ((evt: unknown) => void) | null = null

beforeEach(() => {
  jest.clearAllMocks()
  setTauri(true)
  jest
    .spyOn(transport, "subscribe")
    .mockImplementation((_ch: string, h: (evt: unknown) => void) => {
      captured = h
      return () => {}
    })
})

afterEach(() => {
  setTauri(false)
  jest.restoreAllMocks()
})

describe("sessionControl round-trip", () => {
  it("resolves with the SDK result on a matching control_response", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const p = getSessionContextUsage("s1")
    await flush()
    expect(callSpy).toHaveBeenCalledWith(
      "claude_session_control",
      expect.objectContaining({ sessionId: "s1", method: "getContextUsage" })
    )
    const { requestId } = callSpy.mock.calls[0][1] as { requestId: string }
    captured!({
      type: "control_response",
      sessionId: "s1",
      requestId,
      ok: true,
      method: "getContextUsage",
      result: { percentage: 0.5, totalTokens: 100, maxTokens: 200 },
    })
    await expect(p).resolves.toEqual({ percentage: 0.5, totalTokens: 100, maxTokens: 200 })
  })

  it("rejects with the sidecar error code on ok:false", async () => {
    jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const callSpy = transport.call as jest.Mock
    const p = getSessionMcpStatus("s2")
    await flush()
    const { requestId } = callSpy.mock.calls[0][1] as { requestId: string }
    captured!({
      type: "control_response",
      sessionId: "s2",
      requestId,
      ok: false,
      method: "mcpServerStatus",
      error: "unsupported_provider",
    })
    await expect(p).rejects.toThrow("unsupported_provider")
  })

  it("ignores control_response events for unknown request ids", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const p = setSessionModel("s3", "claude-opus-4-8")
    await flush()
    const { requestId } = callSpy.mock.calls[0][1] as { requestId: string }
    expect(() =>
      captured!({
        type: "control_response",
        sessionId: "s3",
        requestId: "some-other-id",
        ok: true,
        method: "setModel",
      })
    ).not.toThrow()
    // The original promise is still pending — settle it so the test doesn't leak.
    captured!({
      type: "control_response",
      sessionId: "s3",
      requestId,
      ok: true,
      method: "setModel",
    })
    await expect(p).resolves.toBeUndefined()
  })

  it("forwards positional params for mutating methods", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    void reconnectSessionMcpServer("s4", "github")
    await flush()
    expect(callSpy).toHaveBeenCalledWith(
      "claude_session_control",
      expect.objectContaining({ method: "reconnectMcpServer", params: { name: "github" } })
    )
  })

  it("rejects when the underlying transport.call rejects", async () => {
    jest.spyOn(transport, "call").mockRejectedValue(new Error("sidecar not ready"))
    await expect(sessionControl("s5", "getContextUsage")).rejects.toThrow("sidecar not ready")
  })

  it("rejects after the control timeout elapses", async () => {
    jest.useFakeTimers()
    try {
      jest.spyOn(transport, "call").mockResolvedValue(undefined)
      const p = sessionControl("s6", "supportedModels")
      // Flush the microtasks that register the pending entry + fire the call,
      // then trip the 8s timeout.
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(8000)
      await expect(p).rejects.toThrow(/timed out/)
    } finally {
      jest.useRealTimers()
    }
  })
})
