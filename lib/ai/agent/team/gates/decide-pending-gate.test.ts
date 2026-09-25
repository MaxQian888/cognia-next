/** @jest-environment jsdom */

jest.mock("./record-gate-answer", () => ({ recordSquadGateAnswer: jest.fn(async () => null) }))

import { __resetForTesting, pendingCount, waitForDecision } from "@/lib/runtime/approval-bus"
import { usePendingGatesStore, type PendingGate } from "@/stores/agent/pending-gates-store"
import { recordSquadGateAnswer } from "./record-gate-answer"
import { decidePendingGate } from "./decide-pending-gate"

const recordMock = recordSquadGateAnswer as jest.Mock

function gate(over: Partial<PendingGate> = {}): PendingGate {
  return {
    key: { scope: "cost-budget", id: "daily" },
    gateType: "budget",
    title: "Daily budget",
    runId: "run-1",
    openedAt: 1,
    status: "open",
    ...over,
  }
}

async function settle() {
  // The record is a dynamic import plus a promise chain.
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  __resetForTesting()
  usePendingGatesStore.setState({ gates: [gate()] })
})

describe("decidePendingGate", () => {
  it("approves the waiter, removes the gate and records the answer", async () => {
    const decision = waitForDecision(gate().key)
    expect(decidePendingGate(gate(), { outcome: "approve", payload: { extra: 1 } })).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: "approve", plan: { extra: 1 } })
    expect(usePendingGatesStore.getState().gates).toEqual([])
    await settle()
    expect(recordMock).toHaveBeenCalledWith({
      runId: "run-1",
      gateType: "budget",
      decision: "approved",
      title: "Daily budget",
    })
  })

  it("rejects with the feedback the person gave", async () => {
    const decision = waitForDecision(gate().key)
    expect(decidePendingGate(gate(), { outcome: "reject", feedback: "too much" })).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: "reject", feedback: "too much" })
    await settle()
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ decision: "rejected" }))
  })

  it("still removes a gate nobody is waiting on, and says nothing was delivered", () => {
    expect(decidePendingGate(gate(), { outcome: "approve" })).toBe(false)
    expect(usePendingGatesStore.getState().gates).toEqual([])
  })

  it("dismisses a restored gate without resolving any waiter", async () => {
    void waitForDecision(gate().key)
    expect(decidePendingGate(gate({ status: "interrupted" }), { outcome: "dismiss" })).toBe(false)
    expect(pendingCount(gate().key)).toBe(1)
    expect(usePendingGatesStore.getState().gates).toEqual([])
    await settle()
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ decision: "dismissed" }))
  })

  it("leaves no record for a gate that belongs to no run", async () => {
    decidePendingGate(gate({ runId: undefined }), { outcome: "reject" })
    await settle()
    expect(recordMock).not.toHaveBeenCalled()
  })
})
