/**
 * @jest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react"
import { __resetForTesting as resetApprovalBus, waitForDecision } from "@/lib/runtime/approval-bus"
import { useApprovalGate } from "./use-approval-gate"

beforeEach(() => {
  resetApprovalBus()
})

describe("useApprovalGate", () => {
  it("returns approve/reject helpers bound to the scope+id", () => {
    const { result } = renderHook(() => useApprovalGate("agent-team-budget", "run-1"))
    expect(typeof result.current.approve).toBe("function")
    expect(typeof result.current.reject).toBe("function")
  })

  it("approve resolves the matching waiter with payload", async () => {
    const { result } = renderHook(() => useApprovalGate("agent-team-budget", "run-1"))
    const decisionPromise = waitForDecision({ scope: "agent-team-budget", id: "run-1" })
    act(() => {
      result.current.approve({ extraTokens: 1000 })
    })
    const decision = await decisionPromise
    expect(decision.outcome).toBe("approve")
    expect((decision.plan as { extraTokens: number }).extraTokens).toBe(1000)
  })

  it("reject sets outcome=reject with feedback", async () => {
    const { result } = renderHook(() => useApprovalGate("agent-team-budget", "run-1"))
    const decisionPromise = waitForDecision({ scope: "agent-team-budget", id: "run-1" })
    act(() => {
      result.current.reject("nope")
    })
    const decision = await decisionPromise
    expect(decision.outcome).toBe("reject")
    expect(decision.feedback).toBe("nope")
  })
})
