import {
  __resetForTesting,
  approve,
  pendingCount,
  reject,
  waitForDecision,
  type ApprovalDecision,
} from "./approval-bus"

beforeEach(() => {
  __resetForTesting()
})

describe("approval-bus", () => {
  it("waitForDecision resolves with approve outcome", async () => {
    const key = { scope: "gh", id: "draft-1" }
    const promise = waitForDecision(key)
    expect(pendingCount(key)).toBe(1)
    const fanout = approve(key, { body: "looks good" })
    expect(fanout).toBe(1)
    const decision: ApprovalDecision = await promise
    expect(decision.outcome).toBe("approve")
    expect(decision.plan).toEqual({ body: "looks good" })
    expect(pendingCount(key)).toBe(0)
  })

  it("waitForDecision resolves with reject outcome and feedback", async () => {
    const key = { scope: "gh", id: "draft-2" }
    const promise = waitForDecision(key)
    reject(key, "tone too aggressive")
    const decision = await promise
    expect(decision.outcome).toBe("reject")
    expect(decision.feedback).toBe("tone too aggressive")
  })

  it("multiple waiters for the same key fan out together", async () => {
    const key = { scope: "gh", id: "draft-3" }
    const a = waitForDecision(key)
    const b = waitForDecision(key)
    expect(pendingCount(key)).toBe(2)
    expect(approve(key)).toBe(2)
    const [da, db] = await Promise.all([a, b])
    expect(da.outcome).toBe("approve")
    expect(db.outcome).toBe("approve")
    expect(pendingCount(key)).toBe(0)
  })

  it("approve/reject without any waiter returns 0", () => {
    expect(approve({ scope: "gh", id: "empty" })).toBe(0)
    expect(reject({ scope: "gh", id: "empty" }, "x")).toBe(0)
  })

  it("scope isolates keys with the same id", async () => {
    const ghKey = { scope: "gh", id: "shared-id" }
    const teamKey = { scope: "agent-team", id: "shared-id" }
    let teamResolved = false
    const ghPromise = waitForDecision(ghKey)
    const teamPromise = waitForDecision(teamKey).then((d) => {
      teamResolved = true
      return d
    })
    approve(ghKey)
    await ghPromise
    expect(teamResolved).toBe(false)
    expect(pendingCount(teamKey)).toBe(1)
    reject(teamKey, "n")
    await teamPromise
    expect(teamResolved).toBe(true)
  })

  it("aborting a signal rejects the waiter promise and clears the slot", async () => {
    const key = { scope: "gh", id: "to-abort" }
    const ac = new AbortController()
    const promise = waitForDecision(key, ac.signal)
    expect(pendingCount(key)).toBe(1)
    ac.abort(new Error("user-cancelled"))
    await expect(promise).rejects.toThrow(/user-cancelled/)
    expect(pendingCount(key)).toBe(0)
  })

  it("pre-aborted signal rejects synchronously without leaking", async () => {
    const key = { scope: "gh", id: "pre-abort" }
    const ac = new AbortController()
    ac.abort(new Error("pre-aborted"))
    const promise = waitForDecision(key, ac.signal)
    await expect(promise).rejects.toThrow(/pre-aborted/)
    expect(pendingCount(key)).toBe(0)
  })

  it("__resetForTesting drops waiters across all scopes", async () => {
    let settled = false
    waitForDecision({ scope: "gh", id: "leak" }).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    waitForDecision({ scope: "agent-team", id: "leak" }).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    expect(pendingCount({ scope: "gh", id: "leak" })).toBe(1)
    expect(pendingCount({ scope: "agent-team", id: "leak" })).toBe(1)
    __resetForTesting()
    expect(pendingCount({ scope: "gh", id: "leak" })).toBe(0)
    expect(pendingCount({ scope: "agent-team", id: "leak" })).toBe(0)
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it("subsequent waitForDecision after a resolve sees a fresh count", async () => {
    const key = { scope: "gh", id: "reuse" }
    const first = waitForDecision(key)
    approve(key)
    await first
    expect(pendingCount(key)).toBe(0)
    const second = waitForDecision(key)
    expect(pendingCount(key)).toBe(1)
    reject(key, "later no")
    await expect(second).resolves.toMatchObject({ outcome: "reject" })
  })
})
