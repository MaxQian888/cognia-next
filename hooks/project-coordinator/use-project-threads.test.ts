/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (_fn: () => unknown, deps: unknown[], initial: unknown) =>
    deps[0] ? [{ id: "t1" }] : initial,
}))
jest.mock("@/lib/project-coordinator/thread-runtime", () => ({ listProjectThreads: jest.fn() }))

import { useChatStore } from "@/stores/chat"
import { useProjectThreadRows, useProjectThreads } from "./use-project-threads"

const thread = (id: string, extra: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    projectRole: "thread",
    projectThread: { coordinatorSessionId: "c", brief: "b", proposedBy: "coordinator" },
    ...extra,
  }) as ChatSession

beforeEach(() => useChatStore.getState().clear())

describe("useProjectThreads", () => {
  it("reads a coordinator's threads, and nothing without one", () => {
    expect(renderHook(() => useProjectThreads("c")).result.current).toEqual([{ id: "t1" }])
    expect(renderHook(() => useProjectThreads(undefined)).result.current).toEqual([])
  })
})

describe("useProjectThreadRows", () => {
  it("derives live states and orders what needs the user first", () => {
    const store = useChatStore.getState()
    store.holdInBackground("busy", "h")
    store.setSessionStatus("busy", "streaming")
    store.holdInBackground("asking", "h")
    store.pushApproval({
      sessionId: "asking",
      requestId: "r",
      toolName: "Bash",
      input: {},
    } as Parameters<typeof store.pushApproval>[0])
    const { result } = renderHook(() =>
      useProjectThreadRows([thread("idle", { updatedAt: 5 }), thread("busy"), thread("asking")], 10)
    )
    expect(result.current?.map((r) => [r.thread.id, r.state])).toEqual([
      ["asking", "waiting"],
      ["busy", "working"],
      ["idle", "idle"],
    ])
    expect(result.current?.[0].pendingApprovals).toBe(1)
    expect(renderHook(() => useProjectThreadRows(undefined, 1)).result.current).toBeUndefined()
  })
})
