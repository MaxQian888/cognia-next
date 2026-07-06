const emitMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: (...args: unknown[]) => emitMock(...args),
}))

import { ExecutionBroker } from "./broker"
import {
  installExecutionEventBridge,
  isExecutionEventBridgeInstalled,
  __resetExecutionEventBridgeForTesting,
} from "./event-bridge"
import type { ExecutionLeaseRequest } from "./types"

const req = (o: Partial<ExecutionLeaseRequest>): ExecutionLeaseRequest => ({
  kind: "chat",
  label: "t",
  ...o,
})

let broker: ExecutionBroker

beforeEach(() => {
  emitMock.mockClear()
  __resetExecutionEventBridgeForTesting()
  broker = new ExecutionBroker({ limits: { "ai-turn": 8 } })
  installExecutionEventBridge(broker)
})
afterEach(() => __resetExecutionEventBridgeForTesting())

const completeLeg = async (o: Partial<ExecutionLeaseRequest>, outcome: "ok" | "error" = "ok") => {
  const lease = await broker.acquire(req(o))
  lease.release(outcome)
  // Let the fire-and-forget emit run.
  await Promise.resolve()
}

describe("execution event bridge", () => {
  it("emits chat:completed when a chat leg settles", async () => {
    await completeLeg({ kind: "chat", sessionId: "s1", projectId: "p1" })
    expect(emitMock).toHaveBeenCalledWith(
      "chat:completed",
      expect.objectContaining({ kind: "chat", outcome: "ok", sessionId: "s1", projectId: "p1" }),
      "execution-broker"
    )
  })

  it("emits agent:completed for subagent and connector legs", async () => {
    await completeLeg({ kind: "subagent", sessionId: "a" })
    await completeLeg({ kind: "connector", sessionId: "b" })
    const types = emitMock.mock.calls.map((c) => c[0])
    expect(types).toEqual(["agent:completed", "agent:completed"])
  })

  it("carries the failure outcome through", async () => {
    await completeLeg({ kind: "chat", sessionId: "s" }, "error")
    expect(emitMock).toHaveBeenCalledWith(
      "chat:completed",
      expect.objectContaining({ outcome: "error" }),
      "execution-broker"
    )
  })

  it("does NOT duplicate subsystem-level seams (goal / team / workflow / scheduled)", async () => {
    await completeLeg({ kind: "goal", sessionId: "g" })
    await completeLeg({ kind: "team", sessionId: "t" })
    await completeLeg({ kind: "workflow-step", runId: "r" })
    await completeLeg({ kind: "scheduled", taskId: "k" })
    expect(emitMock).not.toHaveBeenCalled()
  })

  it("swallows an emit rejection", async () => {
    emitMock.mockRejectedValueOnce(new Error("scheduler down"))
    await expect(completeLeg({ kind: "chat", sessionId: "s" })).resolves.toBeUndefined()
    await Promise.resolve()
    expect(emitMock).toHaveBeenCalledTimes(1)
  })

  it("does not emit on leg-started (only on completion)", async () => {
    const lease = await broker.acquire(req({ kind: "chat", sessionId: "s" }))
    await Promise.resolve()
    expect(emitMock).not.toHaveBeenCalled()
    lease.release("ok")
  })

  it("install is idempotent and reset tears down", async () => {
    // A second install returns the same teardown and does not double-subscribe.
    installExecutionEventBridge(broker)
    expect(isExecutionEventBridgeInstalled()).toBe(true)
    await completeLeg({ kind: "chat", sessionId: "s" })
    expect(emitMock).toHaveBeenCalledTimes(1)

    __resetExecutionEventBridgeForTesting()
    expect(isExecutionEventBridgeInstalled()).toBe(false)
    await completeLeg({ kind: "chat", sessionId: "s2" })
    // No further emits after teardown.
    expect(emitMock).toHaveBeenCalledTimes(1)
  })
})
