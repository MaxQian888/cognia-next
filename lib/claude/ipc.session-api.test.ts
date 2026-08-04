/** @jest-environment jsdom */
// Tests for the session-level SDK round-trip (`sessionApi` + the typed
// wrappers). Same shape as `ipc.control.test.ts` — capture the handler passed
// to `transport.subscribe` and feed it synthetic events — because both
// round-trips deliberately share one listener and one pending map.

import { transport } from "@/lib/tauri"
import {
  deleteSdkSession,
  forkSdkSession,
  getSdkSessionMessages,
  getSdkSubagentMessages,
  importSdkSessionToStore,
  listSdkSessions,
  renameSdkSession,
  resolveSdkSettings,
  sessionApi,
  tagSdkSession,
  getSessionContextUsage,
} from "./ipc"

const TAURI_KEY = "__TAURI_INTERNALS__"
function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let captured: ((evt: unknown) => void) | null = null

function lastArgs(spy: jest.SpyInstance): Record<string, unknown> {
  return spy.mock.calls.at(-1)![1] as Record<string, unknown>
}

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

describe("sessionApi round-trip", () => {
  it("calls the canonical command and resolves on a matching response", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const p = listSdkSessions({ dir: "/proj" })
    await flush()

    expect(callSpy).toHaveBeenCalledWith(
      // Canonical `agent_*`, not a deprecated `claude_*` alias — this surface
      // is new, so it has no legacy name to keep.
      "agent_session_api",
      expect.objectContaining({ method: "listSessions", params: { dir: "/proj" } })
    )
    const { requestId } = lastArgs(callSpy)
    captured!({
      type: "session_api_response",
      requestId,
      ok: true,
      method: "listSessions",
      result: [{ sessionId: "s1" }],
    })
    await expect(p).resolves.toEqual([{ sessionId: "s1" }])
  })

  it("rejects with the sidecar's stable error code", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const p = importSdkSessionToStore("s1")
    await flush()
    const { requestId } = lastArgs(callSpy)
    captured!({
      type: "session_api_response",
      requestId,
      ok: false,
      method: "importSessionToStore",
      error: "no_session_store",
    })
    await expect(p).rejects.toThrow("no_session_store")
  })

  it("does not settle a control_response that happens to share a request id shape", async () => {
    // Both frames ride one pending map, so the map must be keyed by requestId
    // alone — but a stray id from either frame must be ignored, not mismatched.
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const p = getSdkSessionMessages("s2")
    await flush()
    const { requestId } = lastArgs(callSpy)
    expect(() =>
      captured!({
        type: "session_api_response",
        requestId: "unrelated",
        ok: true,
        method: "getSessionMessages",
      })
    ).not.toThrow()
    captured!({ type: "session_api_response", requestId, ok: true, method: "getSessionMessages" })
    await expect(p).resolves.toBeUndefined()
  })

  it("settles both frame types through the one shared listener", async () => {
    // The whole reason they share: a session_api call orphaned by a restart is
    // exactly as unanswerable as a control, and it must not need its own
    // crash handling to learn that.
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const control = getSessionContextUsage("s3")
    const api = listSdkSessions()
    await flush()

    const controlId = (callSpy.mock.calls[0][1] as { requestId: string }).requestId
    const apiId = (callSpy.mock.calls[1][1] as { requestId: string }).requestId
    captured!({
      type: "control_response",
      sessionId: "s3",
      requestId: controlId,
      ok: true,
      method: "getContextUsage",
      result: { percentage: 0.1 },
    })
    captured!({
      type: "session_api_response",
      requestId: apiId,
      ok: true,
      method: "listSessions",
      result: [],
    })

    await expect(control).resolves.toEqual({ percentage: 0.1 })
    await expect(api).resolves.toEqual([])
  })

  it("rejects every in-flight session call on sidecar_exited", async () => {
    jest.spyOn(transport, "call").mockResolvedValue(undefined)
    const p1 = listSdkSessions()
    const p2 = deleteSdkSession("s1")
    await flush()
    captured!({ type: "sidecar_exited" })
    await expect(p1).rejects.toThrow("sidecar exited")
    await expect(p2).rejects.toThrow("sidecar exited")
  })

  it("uses a longer budget than a control, and says which call timed out", async () => {
    // A scan across every project directory can genuinely outrun the 8s
    // control budget; timing out there reads as broken rather than slow.
    jest.useFakeTimers()
    try {
      jest.spyOn(transport, "call").mockResolvedValue(undefined)
      const p = listSdkSessions()
      await Promise.resolve()
      await Promise.resolve()
      jest.advanceTimersByTime(8000)
      const settled = jest.fn()
      void p.then(settled, settled)
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()

      jest.advanceTimersByTime(12_000)
      await expect(p).rejects.toThrow('session api "listSessions" timed out')
    } finally {
      jest.useRealTimers()
    }
  })

  it("rejects when the underlying transport.call rejects", async () => {
    jest.spyOn(transport, "call").mockRejectedValue(new Error("sidecar not ready"))
    await expect(sessionApi("listSessions")).rejects.toThrow("sidecar not ready")
  })
})

describe("typed wrappers", () => {
  it("forward their params under the SDK's own names", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)

    void getSdkSubagentMessages("s1", "a1")
    await flush()
    expect(lastArgs(callSpy)).toMatchObject({
      method: "getSubagentMessages",
      params: { sessionId: "s1", agentId: "a1" },
    })

    void renameSdkSession("s1", "New title")
    await flush()
    expect(lastArgs(callSpy)).toMatchObject({
      method: "renameSession",
      params: { sessionId: "s1", title: "New title" },
    })

    void forkSdkSession("s1")
    await flush()
    expect(lastArgs(callSpy)).toMatchObject({ method: "forkSession", params: { sessionId: "s1" } })

    void resolveSdkSettings()
    await flush()
    expect(lastArgs(callSpy)).toMatchObject({ method: "resolveSettings" })
  })

  it("sends tag: null through rather than dropping it", async () => {
    // `null` is the documented "clear the tag" value. An `undefined` here would
    // be omitted from the JSON frame and read as "no tag argument".
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    void tagSdkSession("s1", null)
    await flush()
    expect(lastArgs(callSpy)).toMatchObject({
      method: "tagSession",
      params: { sessionId: "s1", tag: null },
    })
  })

  it("forwards the host store descriptor without exposing a renderer-side store location", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue(undefined)
    void importSdkSessionToStore("s1", {
      cwd: "/w",
      claudeAgentSdk: {
        version: 1,
        persistSession: true,
        sessionStore: { backend: "host-sqlite" },
      },
    })
    await flush()
    const args = lastArgs(callSpy)
    expect(args.sendOptions).toEqual({
      cwd: "/w",
      claudeAgentSdk: {
        version: 1,
        persistSession: true,
        sessionStore: { backend: "host-sqlite" },
      },
    })
    // The descriptor names a backend, never a filesystem or database location.
    expect(JSON.stringify(args)).not.toContain("storePath")
  })
})
