import type { AppSettings } from "@cognia/agent-config-types"
import type { CostBudgetSpend, CostBudgetVerdict } from "./cost-budget"

const readSpendMock = jest.fn<Promise<CostBudgetSpend>, [number | undefined]>()
const notifyThresholdMock = jest.fn<Promise<void>, [CostBudgetVerdict, number | undefined]>()
const requestOverrideMock = jest.fn<
  Promise<{ approved: boolean; scopeKey: string }>,
  [CostBudgetVerdict, unknown]
>()

jest.mock("./cost-budget-runtime", () => ({
  readCostBudgetSpend: (now?: number) => readSpendMock(now),
  notifyCostBudgetThreshold: (verdict: CostBudgetVerdict, now?: number) =>
    notifyThresholdMock(verdict, now),
  requestCostBudgetOverride: (verdict: CostBudgetVerdict, options: unknown) =>
    requestOverrideMock(verdict, options),
}))

import { enforceCostBudget, __resetCostBudgetGateForTesting } from "./cost-budget-gate"

function settings(costBudget?: AppSettings["costBudget"]): () => Promise<AppSettings> {
  return async () => ({ id: "singleton", ...(costBudget ? { costBudget } : {}) }) as AppSettings
}

beforeEach(() => {
  __resetCostBudgetGateForTesting()
  readSpendMock.mockReset().mockResolvedValue({ dayUsd: 0, monthUsd: 0 })
  notifyThresholdMock.mockReset().mockResolvedValue(undefined)
  requestOverrideMock.mockReset().mockResolvedValue({ approved: false, scopeKey: "day:*" })
})

describe("enforceCostBudget — nothing configured", () => {
  it("allows without even reading the rollup", async () => {
    await expect(enforceCostBudget({ loadSettings: settings() })).resolves.toEqual({
      allowed: true,
      verdict: null,
      blockedBy: [],
    })
    expect(readSpendMock).not.toHaveBeenCalled()
  })

  it("treats an all-zero policy as no ceiling", async () => {
    await expect(
      enforceCostBudget({
        loadSettings: settings({ dailyUsd: 0, perProviderDailyUsd: { anthropic: 0 } }),
      })
    ).resolves.toMatchObject({ allowed: true })
    expect(readSpendMock).not.toHaveBeenCalled()
  })
})

describe("enforceCostBudget — under the ceiling", () => {
  it("allows and reports the worst scope", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 5, monthUsd: 5 })
    const result = await enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    expect(result.allowed).toBe(true)
    expect(result.verdict).toMatchObject({ scopeKey: "day:*", ratio: 0.5, level: "ok" })
    expect(requestOverrideMock).not.toHaveBeenCalled()
  })

  it("announces a crossed threshold exactly once", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 8.5, monthUsd: 8.5 })
    const load = settings({ dailyUsd: 10 })
    await enforceCostBudget({ loadSettings: load })
    await enforceCostBudget({ loadSettings: load })
    // The same warning on every turn of a long session is noise.
    expect(notifyThresholdMock).toHaveBeenCalledTimes(1)
    expect(notifyThresholdMock.mock.calls[0][0]).toMatchObject({ level: "warning" })
  })

  it("re-arms a scope that fell back to ok", async () => {
    const load = settings({ dailyUsd: 10 })
    readSpendMock.mockResolvedValue({ dayUsd: 8.5, monthUsd: 8.5 })
    await enforceCostBudget({ loadSettings: load })
    // A new day resets the window.
    readSpendMock.mockResolvedValue({ dayUsd: 0, monthUsd: 0 })
    await enforceCostBudget({ loadSettings: load })
    readSpendMock.mockResolvedValue({ dayUsd: 8.5, monthUsd: 8.5 })
    await enforceCostBudget({ loadSettings: load })
    expect(notifyThresholdMock).toHaveBeenCalledTimes(2)
  })

  it("does not let a failed notification block the send", async () => {
    notifyThresholdMock.mockRejectedValue(new Error("notification centre down"))
    readSpendMock.mockResolvedValue({ dayUsd: 9.9, monthUsd: 9.9 })
    await expect(
      enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    ).resolves.toMatchObject({ allowed: true })
  })
})

describe("enforceCostBudget — at the ceiling", () => {
  it("blocks when the override is declined", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    const result = await enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    expect(result.allowed).toBe(false)
    expect(result.blockedBy.map((v) => v.scopeKey)).toEqual(["day:*"])
    expect(requestOverrideMock).toHaveBeenCalledTimes(1)
  })

  it("allows once when the override is approved", async () => {
    requestOverrideMock.mockResolvedValue({ approved: true, scopeKey: "day:*" })
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    await expect(
      enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    ).resolves.toMatchObject({ allowed: true, blockedBy: [] })
  })

  it("asks separately for every blocking scope", async () => {
    requestOverrideMock.mockResolvedValue({ approved: true, scopeKey: "x" })
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    await enforceCostBudget({ loadSettings: settings({ dailyUsd: 10, monthlyUsd: 10 }) })
    // Approving the daily overrun does not authorise the monthly one.
    expect(requestOverrideMock).toHaveBeenCalledTimes(2)
  })

  it("stops asking as soon as one scope is declined", async () => {
    requestOverrideMock.mockResolvedValue({ approved: false, scopeKey: "day:*" })
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    const result = await enforceCostBudget({
      loadSettings: settings({ dailyUsd: 10, monthlyUsd: 10 }),
    })
    expect(requestOverrideMock).toHaveBeenCalledTimes(1)
    expect(result.allowed).toBe(false)
  })

  it("only blocks on the provider actually being charged", async () => {
    readSpendMock.mockResolvedValue({
      dayUsd: 0,
      monthUsd: 0,
      byProviderDayUsd: { anthropic: 12 },
    })
    const load = settings({ perProviderDailyUsd: { anthropic: 10, openai: 10 } })
    await expect(
      enforceCostBudget({ loadSettings: load, providerId: "openai" })
    ).resolves.toMatchObject({ allowed: true })
    await expect(
      enforceCostBudget({ loadSettings: load, providerId: "anthropic" })
    ).resolves.toMatchObject({ allowed: false })
  })

  it("forwards the run id and abort signal to the gate", async () => {
    const controller = new AbortController()
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    await enforceCostBudget({
      loadSettings: settings({ dailyUsd: 10 }),
      runId: "run-9",
      signal: controller.signal,
    })
    expect(requestOverrideMock.mock.calls[0][1]).toMatchObject({
      runId: "run-9",
      signal: controller.signal,
    })
  })
})

describe("enforceCostBudget — failure modes", () => {
  it("fails open when settings cannot be read", async () => {
    await expect(
      enforceCostBudget({
        loadSettings: async () => {
          throw new Error("dexie is gone")
        },
      })
    ).resolves.toMatchObject({ allowed: true })
  })

  it("fails open when the rollup cannot be read", async () => {
    readSpendMock.mockRejectedValue(new Error("dexie is gone"))
    // Blocking work because storage hiccuped is worse than missing one overrun:
    // the next send re-evaluates against a rollup that includes this one.
    await expect(
      enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    ).resolves.toMatchObject({ allowed: true })
    expect(requestOverrideMock).not.toHaveBeenCalled()
  })
})
