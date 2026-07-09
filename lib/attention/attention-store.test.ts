/** @jest-environment jsdom */

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const snapshotMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  fleetGetSnapshot: () => snapshotMock(),
}))

type Handler = (e: { payload: unknown }) => void
const handlers = new Map<string, Handler>()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (topic: string, handler: Handler) => {
    handlers.set(topic, handler)
    return Promise.resolve(jest.fn(() => handlers.delete(topic)))
  },
}))

import {
  subscribeAttention,
  getAttentionSnapshot,
  getAttentionServerSnapshot,
  resetAttentionForTests,
} from "./attention-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { fleetStreamStore } from "@/lib/fleet/fleet-stream-store"
import { FLEET_UPDATE_EVENT } from "@/lib/fleet/types"
import type { PendingApproval } from "@/lib/claude/types"

const flush = () => new Promise((r) => setTimeout(r, 0))

const approval = (requestId: string, sessionId = "s1"): PendingApproval =>
  ({
    requestId,
    sessionId,
    toolUseID: "tu",
    toolName: "Bash",
    input: {},
  }) as PendingApproval

beforeEach(() => {
  jest.clearAllMocks()
  handlers.clear()
  isTauriMock.mockReturnValue(true)
  snapshotMock.mockResolvedValue({ sessions: [], generatedAt: 0 })
  useChatStore.getState().clear()
  usePendingGatesStore.setState({ gates: [] })
  fleetStreamStore.resetForTests()
  resetAttentionForTests()
})

describe("attention-store", () => {
  it("starts empty and getServerSnapshot is always empty", () => {
    expect(getAttentionSnapshot()).toEqual([])
    expect(getAttentionServerSnapshot()).toEqual([])
  })

  it("projects a chat approval pushed after subscribing", async () => {
    const onChange = jest.fn()
    const unsub = subscribeAttention(onChange)
    await flush()
    useChatStore.getState().pushApproval(approval("r1"))
    expect(onChange).toHaveBeenCalled()
    const items = getAttentionSnapshot()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("chat:r1")
    unsub()
  })

  it("projects team gates and fleet permissions together, priority-sorted", async () => {
    const unsub = subscribeAttention(jest.fn())
    await flush()
    useChatStore.getState().pushApproval(approval("r1"))
    usePendingGatesStore.getState().open({
      key: { scope: "agent-team-budget", id: "run-1" },
      gateType: "budget",
      title: "Budget",
      runId: "run-1",
      teamId: "team-1",
    })
    handlers.get(FLEET_UPDATE_EVENT)!({
      payload: {
        generatedAt: 9,
        sessions: [
          {
            agent: "claude-code",
            sessionId: "f1",
            status: "waiting-permission",
            pendingPermission: { requestId: "p", toolName: "bash", detail: null, requestedAt: 1 },
            projectName: "proj",
            capabilities: { approvePermission: true },
            startedAt: 1,
            lastEventAt: 2,
          },
        ],
      },
    })
    const kinds = getAttentionSnapshot().map((i) => i.kind)
    expect(kinds).toEqual(["fleet-permission", "tool-approval", "hitl-gate"])
    unsub()
  })

  it("does not rebuild the snapshot when unrelated chat state changes", async () => {
    const unsub = subscribeAttention(jest.fn())
    await flush()
    useChatStore.getState().pushApproval(approval("r1"))
    const before = getAttentionSnapshot()
    // Unrelated change: message churn does not touch any pendingApprovals array.
    useChatStore.getState().setStatus("streaming")
    expect(getAttentionSnapshot()).toBe(before)
    unsub()
  })

  it("clearing the approval empties the projection", async () => {
    const unsub = subscribeAttention(jest.fn())
    await flush()
    useChatStore.getState().pushApproval(approval("r1"))
    useChatStore.getState().clearApproval("r1", "s1")
    expect(getAttentionSnapshot()).toEqual([])
    unsub()
  })

  it("detaches upstream subscriptions when the last subscriber leaves", async () => {
    const unsub = subscribeAttention(jest.fn())
    await flush()
    unsub()
    // Snapshot no longer updates after detach.
    useChatStore.getState().pushApproval(approval("r9"))
    expect(getAttentionSnapshot()).toEqual([])
  })
})
