import { createRunBudgetGovernor } from "./run-budget-governor"
import type { TeamNotifier } from "@/lib/ai/agent/team/team-notifier"

function makeNotifier(): TeamNotifier {
  return { notify: jest.fn(), suspend: jest.fn(), resume: jest.fn() } as unknown as TeamNotifier
}

function makeGovernor(limit = 1_000) {
  return createRunBudgetGovernor({
    runId: "root-run",
    limit,
    onCritical: "notify",
    notifier: makeNotifier(),
  })
}

describe("createRunBudgetGovernor", () => {
  it("draws every child's usage down the SAME root guard", () => {
    const governor = makeGovernor(1_000)
    const a = governor.allocate("child-a")
    const b = governor.allocate("child-b")
    a.add({ promptTokens: 100, completionTokens: 100, totalTokens: 200 })
    b.add({ promptTokens: 50, completionTokens: 50, totalTokens: 100 })

    expect(governor.totals().usedTokens).toBe(300)
    expect(governor.children()).toEqual([
      expect.objectContaining({ childRunId: "child-a", usedTokens: 200 }),
      expect.objectContaining({ childRunId: "child-b", usedTokens: 100 }),
    ])
  })

  it("counts attempts, provider attempts and failures per child and in totals", () => {
    const governor = makeGovernor()
    const a = governor.allocate("child-a")
    const b = governor.allocate("child-b")
    a.recordAttempt()
    a.recordProviderAttempt()
    a.recordProviderAttempt()
    a.recordFailure()
    b.recordAttempt()

    expect(governor.children()).toEqual([
      expect.objectContaining({ attempts: 1, providerAttempts: 2, failures: 1 }),
      expect.objectContaining({ attempts: 1, providerAttempts: 0, failures: 0 }),
    ])
    expect(governor.totals()).toMatchObject({ attempts: 2, providerAttempts: 2, failures: 1 })
  })

  it("re-allocating the same child id reopens the SAME ledger (idempotent)", () => {
    const governor = makeGovernor()
    governor.allocate("child-a").add({ promptTokens: 0, completionTokens: 0, totalTokens: 100 })
    governor.allocate("child-a").add({ promptTokens: 0, completionTokens: 0, totalTokens: 50 })
    expect(governor.children()).toHaveLength(1)
    expect(governor.children()[0].usedTokens).toBe(150)
  })

  it("children observe root exhaustion (critical level) and the guard escalates once", () => {
    const notifier = makeNotifier()
    const governor = createRunBudgetGovernor({
      runId: "root-run",
      limit: 100,
      onCritical: "notify",
      notifier,
    })
    const a = governor.allocate("child-a")
    expect(a.isExhausted()).toBe(false)
    a.add({ promptTokens: 0, completionTokens: 0, totalTokens: 96 })
    expect(a.isExhausted()).toBe(true)
    // A sibling allocated later sees the same root state.
    expect(governor.allocate("child-b").isExhausted()).toBe(true)
    expect(governor.totals().level).toBe("critical")
  })

  it("a HITL extendLimit on the root guard un-exhausts every child", () => {
    const governor = makeGovernor(100)
    const a = governor.allocate("child-a")
    a.add({ promptTokens: 0, completionTokens: 0, totalTokens: 100 })
    expect(a.isExhausted()).toBe(true)
    governor.guard.extendLimit(1_000)
    expect(a.isExhausted()).toBe(false)
  })

  it("tolerates usage rows without totalTokens (prompt+completion fallback)", () => {
    const governor = makeGovernor()
    governor
      .allocate("child-a")
      .add({ promptTokens: 30, completionTokens: 20 } as unknown as Parameters<
        ReturnType<typeof makeGovernor>["guard"]["add"]
      >[0])
    expect(governor.totals().usedTokens).toBe(50)
    // A fully-empty usage row contributes zero (all ?? 0 fallbacks).
    governor
      .allocate("child-a")
      .add({} as unknown as Parameters<ReturnType<typeof makeGovernor>["guard"]["add"]>[0])
    expect(governor.totals().usedTokens).toBe(50)
  })
})
