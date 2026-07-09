/** @jest-environment jsdom */

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

jest.mock("@/lib/tauri/fleet", () => ({
  fleetGetSnapshot: () => Promise.resolve({ sessions: [], generatedAt: 0 }),
}))

jest.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(jest.fn()),
}))

import { act, renderHook } from "@testing-library/react"
import { useAttentionItems, useAttentionCount } from "./use-attention"
import { resetAttentionForTests } from "@/lib/attention/attention-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import type { PendingApproval } from "@/lib/claude/types"

const approval = (requestId: string, over: Partial<PendingApproval> = {}): PendingApproval =>
  ({
    requestId,
    sessionId: "s1",
    toolUseID: "tu",
    toolName: "Bash",
    input: {},
    ...over,
  }) as PendingApproval

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  useChatStore.getState().clear()
  usePendingGatesStore.setState({ gates: [] })
  resetAttentionForTests()
})

describe("useAttentionItems / useAttentionCount", () => {
  it("reflects pushed approvals reactively", () => {
    const { result } = renderHook(() => useAttentionItems())
    expect(result.current).toEqual([])
    act(() => useChatStore.getState().pushApproval(approval("r1")))
    expect(result.current.map((i) => i.id)).toEqual(["chat:r1"])
  })

  it("counts only live items", () => {
    const { result } = renderHook(() => useAttentionCount())
    act(() => {
      useChatStore.getState().pushApproval(approval("live"))
      useChatStore.getState().pushApproval(approval("dead"))
      useChatStore.getState().markApprovalInterrupted("dead", "s1")
    })
    expect(result.current).toBe(1)
  })
})
