/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { useRemoteSessionStream } from "./use-remote-session-stream"
import type { ClaudeEvent } from "@/lib/claude/types"

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
jest.mock("@/lib/claude/ipc", () => ({
  sendPrompt: (...a: unknown[]) => sendPromptMock(...a),
  interruptSession: (...a: unknown[]) => interruptMock(...a),
  approveTool: (...a: unknown[]) => approveToolMock(...a),
}))

const listMessagesMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (...a: unknown[]) => listMessagesMock(...a),
}))

// applySdkEvent — append a synthetic assistant message, mark turn complete.
jest.mock("@/lib/claude/adapter", () => ({
  applySdkEvent: (messages: unknown[]) => ({
    messages: [...messages, { id: "a1", role: "assistant", parts: [] }],
    turnComplete: true,
    result: undefined,
  }),
}))

beforeEach(() => {
  streamHandler = null
  callMock.mockClear().mockResolvedValue(undefined)
  unsubMock.mockClear()
  sendPromptMock.mockClear()
  interruptMock.mockClear()
  approveToolMock.mockClear()
  listMessagesMock.mockClear().mockResolvedValue([])
})

describe("useRemoteSessionStream", () => {
  it("seeds history and attaches as a watcher on mount", async () => {
    listMessagesMock.mockResolvedValueOnce([{ id: "u1", role: "user", parts: [] }])
    const { result } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("session_attach", {
        sessionId: "sess-1",
        deviceId: "dev-mobile",
      })
    })
    expect(listMessagesMock).toHaveBeenCalledWith("sess-1")
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.canControl).toBe(true)
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

  it("detaches on unmount", async () => {
    const { unmount } = renderHook(() => useRemoteSessionStream("sess-1"))
    await waitFor(() => expect(streamHandler).toBeTruthy())
    callMock.mockClear()
    unmount()
    expect(unsubMock).toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledWith("session_detach", {
      sessionId: "sess-1",
      deviceId: "dev-mobile",
    })
  })
})
