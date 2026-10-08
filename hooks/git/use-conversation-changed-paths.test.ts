/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/code-adoption/persist", () => ({
  listCodeAdoptionTurnsBySession: jest.fn(),
}))

import { listCodeAdoptionTurnsBySession } from "@/lib/code-adoption/persist"
import { useChatStore } from "@/stores/chat/chat-store"
import { useConversationChangedPaths } from "./use-conversation-changed-paths"

const listTurns = listCodeAdoptionTurnsBySession as jest.Mock

function writeMessage(path: string) {
  return {
    id: path,
    role: "assistant",
    parts: [
      {
        type: "tool-Write",
        toolCallId: path,
        state: "output-available",
        input: { file_path: path },
      },
    ],
  }
}

beforeEach(() => {
  listTurns.mockReset().mockResolvedValue([
    {
      id: "s1:1",
      runId: 1,
      sessionId: "s1",
      workspaceRoot: "/repo",
      agentKind: "in-app",
      model: null,
      ts: 1,
      totalFiles: 1,
      totalAdded: 1,
      totalRemoved: 0,
      files: [{ path: "from-shell.ts", added: 1, removed: 0, isNew: true, hunks: [] }],
      truncated: false,
    },
  ])
  useChatStore.setState({
    activeSessionId: "s1",
    messages: [writeMessage("/repo/a.ts")],
    status: "idle",
  } as never)
})

describe("useConversationChangedPaths", () => {
  it("merges the active transcript's edits with the recorded turns", async () => {
    const { result } = renderHook(() => useConversationChangedPaths("s1", "/repo"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect([...result.current.paths].sort()).toEqual(["a.ts", "from-shell.ts"])
    expect(listTurns).toHaveBeenCalledWith("s1")
  })

  it("re-reads the turns when the conversation settles, not while it runs", async () => {
    const { result } = renderHook(() => useConversationChangedPaths("s1", "/repo"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => {
      useChatStore.setState({
        status: "streaming",
        messages: [writeMessage("/repo/b.ts")],
      } as never)
    })
    // Live tool calls show up at once…
    expect(result.current.paths.has("b.ts")).toBe(true)
    expect(listTurns).toHaveBeenCalledTimes(1)
    act(() => {
      useChatStore.setState({ status: "idle" } as never)
    })
    // …and the settled turn is read again.
    await waitFor(() => expect(listTurns).toHaveBeenCalledTimes(2))
  })

  it("is empty and ready without a conversation", () => {
    const { result } = renderHook(() => useConversationChangedPaths(null, "/repo"))
    expect(result.current.ready).toBe(true)
    expect(result.current.paths.size).toBe(0)
    expect(listTurns).not.toHaveBeenCalled()
  })

  it("survives a failed read with the tool calls alone", async () => {
    listTurns.mockRejectedValue(new Error("dexie"))
    const { result } = renderHook(() => useConversationChangedPaths("s1", "/repo"))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect([...result.current.paths]).toEqual(["a.ts"])
  })
})
