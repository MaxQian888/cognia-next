import {
  approve,
  reject,
  waitForDecision,
  pendingCount,
  __resetForTesting,
  type PlanApprovalDecision,
} from "./plan-approval-bus"

beforeEach(() => {
  __resetForTesting()
})

describe("plan-approval-bus", () => {
  it("waitForDecision resolves with approve outcome when approve() is called", async () => {
    const promise = waitForDecision("team-1")
    expect(pendingCount("team-1")).toBe(1)
    const fanout = approve("team-1", { steps: ["a", "b"] })
    expect(fanout).toBe(1)
    const decision: PlanApprovalDecision = await promise
    expect(decision.outcome).toBe("approve")
    expect(decision.plan).toEqual({ steps: ["a", "b"] })
    expect(pendingCount("team-1")).toBe(0)
  })

  it("waitForDecision resolves with reject outcome when reject() is called", async () => {
    const promise = waitForDecision("team-2")
    reject("team-2", "needs more detail")
    const decision = await promise
    expect(decision.outcome).toBe("reject")
    expect(decision.feedback).toBe("needs more detail")
  })

  it("multiple waiters for the same teamId all receive the same fanout", async () => {
    const a = waitForDecision("team-3")
    const b = waitForDecision("team-3")
    expect(pendingCount("team-3")).toBe(2)
    const count = approve("team-3")
    expect(count).toBe(2)
    const [da, db] = await Promise.all([a, b])
    expect(da.outcome).toBe("approve")
    expect(db.outcome).toBe("approve")
    expect(pendingCount("team-3")).toBe(0)
  })

  it("approve() / reject() with no waiters returns 0", () => {
    expect(approve("team-empty")).toBe(0)
    expect(reject("team-empty", "x")).toBe(0)
  })

  it("waiters are isolated by teamId", async () => {
    let resolvedB = false
    const a = waitForDecision("team-A")
    const b = waitForDecision("team-B").then((d) => {
      resolvedB = true
      return d
    })
    approve("team-A")
    await a
    expect(resolvedB).toBe(false)
    expect(pendingCount("team-B")).toBe(1)
    reject("team-B", "no")
    await b
    expect(resolvedB).toBe(true)
  })

  it("aborting before resolve rejects the promise and clears the waiter", async () => {
    const ac = new AbortController()
    const promise = waitForDecision("team-abort", ac.signal)
    expect(pendingCount("team-abort")).toBe(1)
    ac.abort(new Error("user-cancelled"))
    await expect(promise).rejects.toThrow(/user-cancelled/)
    expect(pendingCount("team-abort")).toBe(0)
  })

  it("aborting an already-aborted signal rejects synchronously without leaking a waiter", async () => {
    const ac = new AbortController()
    ac.abort(new Error("pre-aborted"))
    const promise = waitForDecision("team-pre-abort", ac.signal)
    await expect(promise).rejects.toThrow(/pre-aborted/)
    expect(pendingCount("team-pre-abort")).toBe(0)
  })

  it("__resetForTesting drops every pending waiter without resolving", async () => {
    let settled = false
    waitForDecision("team-leak").then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    expect(pendingCount("team-leak")).toBe(1)
    __resetForTesting()
    expect(pendingCount("team-leak")).toBe(0)
    // Microtask drain — the promise should still be unresolved.
    await Promise.resolve()
    expect(settled).toBe(false)
  })
})
