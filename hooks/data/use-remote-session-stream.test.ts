/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { useRemoteSessionStream } from "./use-remote-session-stream"
import { toast } from "sonner"
import type { ClaudeEvent } from "@cognia/agent-config-types"
import { ATTACH_LEASE_RENEW_INTERVAL_MS } from "@/lib/companion/device-presence-registry"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() },
}))

const runSyncDownMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (...a: unknown[]) => runSyncDownMock(...a),
}))

const toastError = toast.error as jest.Mock
const toastWarning = toast.warning as jest.Mock

// ── transport mock: capture the claude://message handler + record calls ──
let streamHandler: ((evt: ClaudeEvent) => void) | null = null
const callMock = jest.fn().mockResolvedValue(undefined)
const unsubMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: {
    call: (name: string, args?: unknown) => callMock(name, args),
    subscribe: (event: string, handler: (evt: ClaudeEvent) => void) => {
      if (event === "claude://message") streamHandler = handler
      return unsubMock
    },
  },
}))

jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => ({ deviceId: "dev-mobile" }),
}))

const sendPromptMock = jest.fn().mockResolvedValue(undefined)
const interruptMock = jest.fn().mockResolvedValue(undefined)
const approveToolMock = jest.fn().mockResolvedValue(undefined)
const enqueueHostStateIntentMock = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (...a: unknown[]) => sendPromptMock(...a),
  interruptSession: (...a: unknown[]) => interruptMock(...a),
  approveTool: (...a: unknown[]) => approveToolMock(...a),
}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (...args: unknown[]) => enqueueHostStateIntentMock(...args),
}))

const listMessagesMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (...a: unknown[]) => listMessagesMock(...a),
}))

let mockAdapterTurnComplete = true

// applySdkEvent — append a synthetic assistant message with a controllable
// completion marker so revision reconciliation can be tested independently.
jest.mock("@/lib/claude/adapter", () => ({
  applySdkEvent: (messages: unknown[]) => ({
    messages: [...messages, { id: "a1", role: "assistant", parts: [] }],
    turnComplete: mockAdapterTurnComplete,
    result: undefined,
  }),
}))

beforeEach(() => {
  streamHandler = null
  callMock.mockClear().mockResolvedValue(undefined)
  unsubMock.mockClear()
  sendPromptMock.mockClear().mockResolvedValue(undefined)
  interruptMock.mockClear().mockResolvedValue(undefined)
  approveToolMock.mockClear().mockResolvedValue(undefined)
  enqueueHostStateIntentMock.mockReset().mockResolvedValue(null)
  listMessagesMock.mockClear().mockResolvedValue([])
  runSyncDownMock.mockClear().mockResolvedValue([])
  toastError.mockClear()
  toastWarning.mockClear()
  mockAdapterTurnComplete = true
})

describe("useRemoteSessionStream", () => {
  it("does not hydrate or sync full history in transcript-capable mode", async () => {
    renderHook(() => useRemoteSessionStream("sess-1", { seedHistory: false }))

    await waitFor(() => expect(streamHandler).toBeTruthy())
    expect(listMessagesMock).not.toHaveBeenCalled()
    expect(runSyncDownMock).not.toHaveBeenCalled()
  })

  it("releases a completed live turn after the folded timeline adopts it", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1", { seedHistory: false }))
    await waitFor(() => expect(streamHandler).toBeTruthy())

    act(() => {
      streamHandler?.({
        type: "event",
        sessionId: "sess-1",
        event: { type: "assistant" },
      } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    act(() => result.current.reconcileTranscript())

    expect(result.current.messages).toEqual([])
  })

  it("keeps an active live turn during timeline reconciliation", async () => {
    mockAdapterTurnComplete = false
    const { result } = renderHook(() => useRemoteSessionStream("sess-1", { seedHistory: false }))
    await waitFor(() => expect(streamHandler).toBeTruthy())

    act(() => {
      streamHandler?.({
        type: "event",
        sessionId: "sess-1",
        event: { type: "assistant" },
      } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    act(() => result.current.reconcileTranscript())

    expect(result.current.messages).toHaveLength(1)
  })

  it("seeds history and attaches as a watcher on mount", async () => {
    listMessagesMock.mockResolvedValueOnce([{ id: "u1", role: "user", parts: [] }])
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("session_attach", {
        sessionId: "sess-1",
        // Asks for control and lets the Host narrow it. No `deviceId`: the
        // Host binds the attachment to the authenticated caller, so sending
        // one only invited a device to attach under a borrowed id.
        mode: "control",
        // Reported so the Host can skip a native push for a prompt this device
        // is already showing; jsdom reports the document as visible.
        attention: "foreground",
      })
    })
    expect(listMessagesMock).toHaveBeenCalledWith("sess-1")
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.canControl).toBe(true)
  })

  /**
   * The Host attaches a device with no live event stream as an observer: it
   * cannot receive the `permission_request` frame its approval would answer.
   * Showing a composer in that state offers a control the Host will refuse.
   */
  it("downgrades to observe-only when the host grants an observe attachment", async () => {
    callMock.mockImplementation(async (name: string) =>
      name === "session_attach"
        ? { mode: "observe", downgradeReason: "event-plane-not-ready" }
        : undefined
    )
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(result.current.canControl).toBe(false))
    // The two refusals need different UI: a missing grant is permanent until
    // someone toggles it on the desktop, a stream that has not caught up clears
    // itself on reconnect.
    expect(result.current.attachDowngrade).toBe("event-plane-not-ready")
  })

  /**
   * The Host owns the lease cadence. A client renewing on a stale constant
   * after the Host shortened its TTL would drop its attachment between
   * renewals, so the reported interval wins over the compiled-in default.
   */
  it("adopts the renewal interval the host reports", async () => {
    jest.useFakeTimers()
    try {
      callMock.mockImplementation(async (name: string) =>
        name === "session_attach"
          ? { mode: "control", downgradeReason: null, renewIntervalMs: 5_000 }
          : undefined
      )
      renderHook(() => useRemoteSessionStream("sess-1"))
      await act(async () => {
        await Promise.resolve()
      })
      const attachCalls = () =>
        callMock.mock.calls.filter(([name]: [string]) => name === "session_attach").length
      const initial = attachCalls()

      await act(async () => {
        jest.advanceTimersByTime(5_000)
        await Promise.resolve()
      })
      expect(attachCalls()).toBe(initial + 1)
    } finally {
      jest.useRealTimers()
    }
  })

  /**
   * The Host's attachment is a lease that lapses after 90s. Without renewal a
   * viewer left open would silently stop receiving approval prompts.
   */
  it("renews the attachment on an interval so the lease never lapses while open", async () => {
    jest.useFakeTimers()
    try {
      renderHook(() => useRemoteSessionStream("sess-1"))
      await act(async () => {
        await Promise.resolve()
      })
      const attachCalls = () =>
        callMock.mock.calls.filter(([name]: [string]) => name === "session_attach").length
      const initial = attachCalls()
      expect(initial).toBeGreaterThanOrEqual(1)

      await act(async () => {
        jest.advanceTimersByTime(ATTACH_LEASE_RENEW_INTERVAL_MS)
        await Promise.resolve()
      })
      expect(attachCalls()).toBe(initial + 1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("downgrades to observe-only when session_attach is rejected", async () => {
    callMock.mockImplementation(async (name: string) => {
      if (name === "session_attach") throw new Error("403 remote_control_forbidden")
      return undefined
    })
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(result.current.canControl).toBe(false))
    // Still subscribed to the stream despite no control grant.
    expect(streamHandler).toBeTruthy()
  })

  it("applies an SDK event into the reconstructed message list", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    act(() => {
      streamHandler?.({
        type: "event",
        sessionId: "sess-1",
        event: { type: "assistant" },
      } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.status).toBe("idle")
  })

  it("coalesces multiple streamed events into one animation-frame UI commit", async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    const requestFrame = jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())

    act(() => {
      streamHandler?.({
        type: "event",
        sessionId: "sess-1",
        event: { type: "assistant" },
      } as unknown as ClaudeEvent)
      streamHandler?.({
        type: "event",
        sessionId: "sess-1",
        event: { type: "assistant" },
      } as unknown as ClaudeEvent)
    })

    expect(result.current.messages).toHaveLength(0)
    expect(frameCallbacks).toHaveLength(1)
    act(() => frameCallbacks[0]?.(0))
    expect(result.current.messages).toHaveLength(2)
    requestFrame.mockRestore()
  })

  it("ignores events for a different session", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    act(() => {
      streamHandler?.({
        type: "event",
        sessionId: "other",
        event: { type: "assistant" },
      } as unknown as ClaudeEvent)
    })
    expect(result.current.messages).toHaveLength(0)
  })

  it("surfaces a permission_request and resolves it via approveTool", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    act(() => {
      streamHandler?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-1",
        toolUseID: "tu-1",
        toolName: "write",
        input: {},
      } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(result.current.pendingApproval?.requestId).toBe("req-1"))

    await act(async () => {
      await result.current.respond("deny")
    })
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "req-1", "deny")
    expect(result.current.pendingApproval).toBeNull()
  })

  it("send forwards to sendPrompt; interrupt forwards to interruptSession", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    await act(async () => {
      await result.current.send("hello")
    })
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "hello")
    await act(async () => {
      await result.current.interrupt()
    })
    expect(interruptMock).toHaveBeenCalledWith("sess-1")
  })

  it("uses durable HostState actions for attached send, interrupt, and approval", async () => {
    enqueueHostStateIntentMock.mockResolvedValue({ id: "queued", status: "pending" })
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())

    await act(async () => {
      await result.current.send("host message")
      await result.current.interrupt()
    })
    act(() => {
      streamHandler?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-host",
        toolUseID: "tu-host",
        toolName: "write",
        input: {},
      } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(result.current.pendingApproval?.requestId).toBe("req-host"))
    await act(async () => {
      await result.current.respond("allow")
    })

    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        action: expect.objectContaining({ kind: "message.enqueue", text: "host message" }),
      })
    )
    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      action: { kind: "turn.abort" },
    })
    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      action: { kind: "approval.respond", requestId: "req-host", decision: "allow" },
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(interruptMock).not.toHaveBeenCalled()
    expect(approveToolMock).not.toHaveBeenCalled()
  })

  it("marks the session ended on session_ended and clears any pending approval", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    act(() => {
      streamHandler?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-1",
        toolUseID: "tu-1",
        toolName: "write",
        input: {},
      } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(result.current.pendingApproval).not.toBeNull())
    act(() => {
      streamHandler?.({ type: "session_ended", sessionId: "sess-1" } as unknown as ClaudeEvent)
    })
    expect(result.current.sessionEnded).toBe(true)
    expect(result.current.status).toBe("idle")
    expect(result.current.pendingApproval).toBeNull()
  })

  it("treats a sidecar_exited frame (no sessionId) as a session end", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    act(() => {
      streamHandler?.({ type: "sidecar_exited" } as unknown as ClaudeEvent)
    })
    expect(result.current.sessionEnded).toBe(true)
  })

  it("re-seeds history from Dexie on a resync_required frame", async () => {
    renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    expect(listMessagesMock).toHaveBeenCalledTimes(1)
    act(() => {
      // synthetic, non-session-scoped frame dispatched by the transport
      streamHandler?.({ type: "resync_required" } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(2))
  })

  it("adopts an equally-sized corrected snapshot after resync", async () => {
    listMessagesMock
      .mockResolvedValueOnce([
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "stale" }] },
      ])
      .mockResolvedValueOnce([
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "corrected" }] },
      ])
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => {
      streamHandler?.({ type: "resync_required" } as unknown as ClaudeEvent)
    })

    await waitFor(() => {
      expect((result.current.messages[0]?.parts[0] as { text?: string } | undefined)?.text).toBe(
        "corrected"
      )
    })
  })

  it("adopts authoritative deletions after resync when no newer stream event arrived", async () => {
    listMessagesMock
      .mockResolvedValueOnce([
        { id: "u1", role: "user", parts: [] },
        { id: "a1", role: "assistant", parts: [] },
      ])
      .mockResolvedValueOnce([{ id: "u1", role: "user", parts: [] }])
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    act(() => {
      streamHandler?.({ type: "resync_required" } as unknown as ClaudeEvent)
    })

    await waitFor(() => expect(result.current.messages).toHaveLength(1))
  })

  it("clears a pending approval when a later event advances the turn", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    act(() => {
      streamHandler?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-1",
        toolUseID: "tu-1",
        toolName: "write",
        input: {},
      } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(result.current.pendingApproval).not.toBeNull())
    act(() => {
      streamHandler?.({
        type: "event",
        sessionId: "sess-1",
        event: { type: "assistant" },
      } as unknown as ClaudeEvent)
    })
    expect(result.current.pendingApproval).toBeNull()
  })

  it("resets status to idle and toasts when a send fails", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("network down"))
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    // The rejection is the contract: the composer clears its text and its
    // staged files only when `send` resolves, so swallowing here would empty a
    // composer for a message that never left the device.
    await act(async () => {
      await expect(result.current.send("hello")).rejects.toThrow("network down")
    })
    expect(result.current.status).toBe("idle")
    expect(toastError).toHaveBeenCalled()
  })

  it("downgrades to observe-only when a send is forbidden (control revoked)", async () => {
    sendPromptMock.mockRejectedValueOnce({ code: "http_403", message: "forbidden" })
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    await act(async () => {
      await expect(result.current.send("hello")).rejects.toMatchObject({ code: "http_403" })
    })
    expect(result.current.canControl).toBe(false)
    expect(toastWarning).toHaveBeenCalled()
  })

  it("flags notFound when session_attach 404s", async () => {
    callMock.mockImplementation(async (name: string) => {
      if (name === "session_attach") throw { code: "http_404", message: "not found" }
      return undefined
    })
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(result.current.notFound).toBe(true))
    expect(result.current.canControl).toBe(false)
  })

  it("downgrades to observe-only (not notFound) when session_attach 403s by code", async () => {
    callMock.mockImplementation(async (name: string) => {
      if (name === "session_attach") throw { code: "http_403", message: "forbidden" }
      return undefined
    })
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(result.current.canControl).toBe(false))
    expect(result.current.notFound).toBe(false)
  })

  it("does not fire a spurious interrupt when nothing is in flight", async () => {
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    await act(async () => {
      await result.current.interrupt()
    })
    expect(interruptMock).not.toHaveBeenCalled()
  })

  it("keeps the approval card and toasts when respond fails", async () => {
    approveToolMock.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    act(() => {
      streamHandler?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-1",
        toolUseID: "tu-1",
        toolName: "write",
        input: {},
      } as unknown as ClaudeEvent)
    })
    await waitFor(() => expect(result.current.pendingApproval).not.toBeNull())
    await act(async () => {
      await result.current.respond("deny")
    })
    expect(toastError).toHaveBeenCalled()
    expect(result.current.pendingApproval).not.toBeNull()
  })

  it("detaches on unmount", async () => {
    const { unmount } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    callMock.mockClear()
    unmount()
    expect(unsubMock).toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledWith("session_detach", { sessionId: "sess-1" })
  })
})
