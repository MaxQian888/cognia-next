/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const binding = {
  current: { sessionId: "shared", syncCursor: 3 } as Record<string, unknown> | undefined,
}
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => binding.current,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
const active = new Set<string>()
jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  hasActiveSharedRun: (id: string) => active.has(id),
}))
const storeState: { sessions: Record<string, { messages: Array<{ id: string }> }> } = {
  sessions: {},
}
jest.mock("@/stores/chat", () => ({ useChatStore: { getState: () => storeState } }))
jest.mock("@/lib/collab/shared-chat-sync", () => ({
  sharedMessageLocalId: (session: string, remote: string) =>
    `${session}:message:${JSON.stringify(remote)}`,
}))

import type { TranscriptLiveFrame } from "@/lib/chat/transcript/live-frames"
import { publishSharedLiveFrame, resetSharedLiveForTesting } from "@/lib/collab/shared-live-frames"
import { localSharedLiveFrame, useSharedLiveReply } from "./use-shared-live-reply"

function frame(overrides: Partial<TranscriptLiveFrame> = {}): TranscriptLiveFrame {
  return {
    sessionId: "shared",
    messageId: "reply",
    replyTo: "request",
    seq: 1,
    base: 0,
    keyframe: true,
    state: "streaming",
    parts: [{ type: "text", text: "hi" }],
    ...overrides,
  }
}

beforeEach(() => {
  resetSharedLiveForTesting()
  active.clear()
  storeState.sessions = {}
  binding.current = { sessionId: "shared", syncCursor: 3 }
})

describe("localSharedLiveFrame", () => {
  it("maps server ids through the projection formula on a device that wrote neither", () => {
    expect(localSharedLiveFrame("local", frame())).toMatchObject({
      sessionId: "local",
      messageId: 'local:message:"reply"',
      replyTo: 'local:message:"request"',
    })
  })

  it("keeps the ids of messages this device wrote itself", () => {
    storeState.sessions.local = { messages: [{ id: "request" }] }
    expect(localSharedLiveFrame("local", frame())).toMatchObject({
      messageId: 'local:message:"reply"',
      replyTo: "request",
    })
  })
})

describe("useSharedLiveReply", () => {
  it("draws the live reply under this device's ids", async () => {
    const { result } = renderHook(() => useSharedLiveReply("local"))
    act(() => publishSharedLiveFrame("shared", frame()))
    await waitFor(() =>
      expect(result.current).toMatchObject({
        messageId: 'local:message:"reply"',
        state: "streaming",
        parts: [{ type: "text", text: "hi" }],
      })
    )
  })

  it("ignores frames on the device that executes the run", () => {
    active.add("local")
    const { result } = renderHook(() => useSharedLiveReply("local"))
    act(() => publishSharedLiveFrame("shared", frame()))
    expect(result.current).toBeNull()
  })

  it("lets a settled reply go once the pull reads past its revision", async () => {
    const { result, rerender } = renderHook(() => useSharedLiveReply("local"))
    act(() => publishSharedLiveFrame("shared", frame({ state: "settled", afterRevision: 4 })))
    await waitFor(() => expect(result.current?.state).toBe("settled"))
    binding.current = { sessionId: "shared", syncCursor: 5 }
    rerender()
    expect(result.current).toBeNull()
  })

  it("draws nothing for a private conversation", () => {
    binding.current = undefined
    const { result } = renderHook(() => useSharedLiveReply("local"))
    act(() => publishSharedLiveFrame("shared", frame()))
    expect(result.current).toBeNull()
  })
})
