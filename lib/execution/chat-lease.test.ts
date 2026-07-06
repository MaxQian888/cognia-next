import { acquireChatLease, releaseChatLease, __resetChatLeasesForTesting } from "./chat-lease"
import { ExecutionBroker, __resetExecutionBrokerForTesting, getExecutionBroker } from "./broker"
import { useChatStore } from "@/stores/chat"
import { interruptSession } from "@/lib/claude/ipc"

jest.mock("@/lib/claude/ipc", () => ({
  interruptSession: jest.fn().mockResolvedValue(undefined),
}))

const interruptMock = interruptSession as jest.MockedFunction<typeof interruptSession>

const setStatus = (id: string, status: "idle" | "streaming" | "awaiting_approval" | "error") => {
  useChatStore.getState().setSessionStatus(id, status)
}

beforeEach(() => {
  __resetChatLeasesForTesting()
  __resetExecutionBrokerForTesting(new ExecutionBroker({ limits: { "ai-turn": 3 } }))
  useChatStore.getState().clear()
  interruptMock.mockClear()
})

afterEach(() => {
  __resetChatLeasesForTesting()
  __resetExecutionBrokerForTesting()
})

describe("chat-lease", () => {
  it("acquires a broker leg and releases it when the turn settles", async () => {
    const broker = getExecutionBroker()
    await acquireChatLease({ sessionId: "s", projectId: "p1", label: "My chat" })
    expect(broker.countRunning()).toBe(1)
    const leg = broker.list()[0]
    expect(leg).toMatchObject({ kind: "chat", label: "My chat", projectId: "p1", sessionId: "s" })

    // Observe the active state, then settle → released.
    setStatus("s", "streaming")
    setStatus("s", "idle")
    expect(broker.countRunning()).toBe(0)
  })

  it("releases as error when the turn ends in error", async () => {
    const broker = getExecutionBroker()
    const outcomes: string[] = []
    broker.onEvent((e) => {
      if (e.type === "leg-completed") outcomes.push(e.outcome)
    })
    await acquireChatLease({ sessionId: "s", label: "x" })
    setStatus("s", "streaming")
    setStatus("s", "error")
    expect(outcomes).toEqual(["error"])
    expect(broker.countRunning()).toBe(0)
  })

  it("does not release before the turn has been observed active", async () => {
    const broker = getExecutionBroker()
    await acquireChatLease({ sessionId: "s", label: "x" })
    // An idle status arriving before the `streaming` flip must NOT release.
    setStatus("s", "idle")
    expect(broker.countRunning()).toBe(1)
    // Once it streams then settles, it releases.
    setStatus("s", "streaming")
    setStatus("s", "idle")
    expect(broker.countRunning()).toBe(0)
  })

  it("is a no-op for a continuation (session already holds a lease)", async () => {
    const broker = getExecutionBroker()
    await acquireChatLease({ sessionId: "s", label: "first" })
    await acquireChatLease({ sessionId: "s", label: "second" })
    expect(broker.countRunning()).toBe(1)
    setStatus("s", "streaming")
    setStatus("s", "idle")
    expect(broker.countRunning()).toBe(0)
  })

  it("bridges a broker-side cancel to interruptSession", async () => {
    const broker = getExecutionBroker()
    await acquireChatLease({ sessionId: "s", label: "x" })
    expect(broker.cancelBySession("s")).toBe(1)
    expect(interruptMock).toHaveBeenCalledWith("s")
  })

  it("releaseChatLease releases immediately and is idempotent", async () => {
    const broker = getExecutionBroker()
    await acquireChatLease({ sessionId: "s", label: "x" })
    releaseChatLease("s", "cancelled")
    expect(broker.countRunning()).toBe(0)
    // Second call is a no-op.
    expect(() => releaseChatLease("s")).not.toThrow()
    expect(() => releaseChatLease("never-held")).not.toThrow()
  })

  it("reset releases held leases and detaches the watcher", async () => {
    const broker = getExecutionBroker()
    await acquireChatLease({ sessionId: "s", label: "x" })
    expect(broker.countRunning()).toBe(1)
    __resetChatLeasesForTesting()
    expect(broker.countRunning()).toBe(0)
    // After reset, status changes must not throw (watcher detached).
    expect(() => setStatus("s", "streaming")).not.toThrow()
  })
})
