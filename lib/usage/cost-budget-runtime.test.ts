/** @jest-environment jsdom */
import type { CostBudgetVerdict } from "./cost-budget"

const getCostRangeMock = jest.fn()
const notifyMock = jest.fn<Promise<string>, [Record<string, unknown>]>()

jest.mock("@/lib/db/provider-cost-daily", () => ({
  localDayString: (now: number) => new Date(now).toISOString().slice(0, 10),
  getCostRange: (...args: unknown[]) => getCostRangeMock(...args),
}))

const listProjectUsageMock = jest.fn()

jest.mock("@/lib/db/session-usage", () => ({
  listLocalUsageForProjectSince: (...args: unknown[]) => listProjectUsageMock(...args),
}))

jest.mock("@/lib/notifications/runtime", () => ({
  notify: (input: Record<string, unknown>) => notifyMock(input),
}))

import { approve, reject, __resetForTesting } from "@/lib/runtime/approval-bus"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useProjectStore } from "@/stores/project/project-store"
import {
  costBudgetApprovalKey,
  localWindowStarts,
  monthStartDay,
  notifyCostBudgetThreshold,
  readCostBudgetSpend,
  readProjectSpend,
  requestCostBudgetOverride,
  COST_BUDGET_APPROVAL_SCOPE,
} from "./cost-budget-runtime"

// 2026-08-18T12:00:00Z
const NOW = Date.UTC(2026, 7, 18, 12)

function verdict(over: Partial<CostBudgetVerdict> = {}): CostBudgetVerdict {
  return {
    scopeKey: "day:*",
    period: "day",
    target: "*",
    usedUsd: 9.5,
    limitUsd: 10,
    ratio: 0.95,
    level: "critical",
    ...over,
  }
}

beforeEach(() => {
  getCostRangeMock.mockReset()
  listProjectUsageMock.mockReset().mockResolvedValue([])
  notifyMock.mockReset().mockResolvedValue("id")
  __resetForTesting()
  usePendingGatesStore.setState({ gates: [] })
})

describe("readCostBudgetSpend", () => {
  it("splits one range read into today and this month, globally and per provider", async () => {
    getCostRangeMock.mockResolvedValue([
      { day: "2026-08-01", providerId: "anthropic", totalCostUsd: 5 },
      { day: "2026-08-18", providerId: "anthropic", totalCostUsd: 3 },
      { day: "2026-08-18", providerId: "openai", totalCostUsd: 2 },
    ])
    const spend = await readCostBudgetSpend(NOW)
    // One query covers both windows — two reads could only disagree.
    expect(getCostRangeMock).toHaveBeenCalledWith("2026-08-01", "2026-08-18")
    expect(spend).toEqual({
      dayUsd: 5,
      monthUsd: 10,
      byProviderDayUsd: { anthropic: 3, openai: 2 },
      byProviderMonthUsd: { anthropic: 8, openai: 2 },
    })
  })

  it("is all zeroes on an empty rollup", async () => {
    getCostRangeMock.mockResolvedValue([])
    await expect(readCostBudgetSpend(NOW)).resolves.toMatchObject({ dayUsd: 0, monthUsd: 0 })
  })

  it("treats a non-finite stored cost as zero", async () => {
    getCostRangeMock.mockResolvedValue([
      { day: "2026-08-18", providerId: "x", totalCostUsd: Number.NaN },
    ])
    await expect(readCostBudgetSpend(NOW)).resolves.toMatchObject({ dayUsd: 0 })
  })

  it("anchors the month at its first day", () => {
    expect(monthStartDay(NOW)).toBe("2026-08-01")
  })

  it("adds the named projects' day and month spend", async () => {
    getCostRangeMock.mockResolvedValue([])
    const { dayStart, monthStart } = localWindowStarts(NOW)
    listProjectUsageMock.mockImplementation(async (projectId: string) =>
      projectId === "alpha"
        ? [
            { at: monthStart + 1, costUsd: 4 },
            { at: dayStart + 1, costUsd: 1.5 },
            { at: dayStart + 2, costUsd: Number.NaN },
          ]
        : []
    )
    const spend = await readCostBudgetSpend(NOW, ["alpha", "beta", "alpha"])
    expect(listProjectUsageMock).toHaveBeenCalledTimes(2)
    expect(listProjectUsageMock).toHaveBeenCalledWith("alpha", monthStart)
    expect(spend.byProjectDayUsd).toEqual({ alpha: 1.5, beta: 0 })
    expect(spend.byProjectMonthUsd).toEqual({ alpha: 5.5, beta: 0 })
  })

  it("leaves project figures out when no project is asked for", async () => {
    getCostRangeMock.mockResolvedValue([])
    const spend = await readCostBudgetSpend(NOW)
    expect(spend.byProjectDayUsd).toBeUndefined()
    expect(listProjectUsageMock).not.toHaveBeenCalled()
  })
})

describe("readProjectSpend / localWindowStarts", () => {
  it("windows on local midnight and the first of the month", () => {
    const { dayStart, monthStart } = localWindowStarts(NOW)
    const local = new Date(NOW)
    expect(new Date(dayStart).getDate()).toBe(local.getDate())
    expect(new Date(dayStart).getHours()).toBe(0)
    expect(new Date(monthStart).getDate()).toBe(1)
  })

  it("sums only positive costs", async () => {
    const { dayStart } = localWindowStarts(NOW)
    listProjectUsageMock.mockResolvedValue([
      { at: dayStart, costUsd: 2 },
      { at: dayStart, costUsd: -1 },
    ])
    await expect(readProjectSpend("alpha", NOW)).resolves.toEqual({ dayUsd: 2, monthUsd: 2 })
  })
})

describe("notifyCostBudgetThreshold", () => {
  it("sends a warning that does not bypass DND", async () => {
    await notifyCostBudgetThreshold(verdict({ level: "warning", ratio: 0.8 }), NOW)
    expect(notifyMock.mock.calls[0][0]).toMatchObject({
      source: "system",
      level: "warning",
      directed: false,
    })
  })

  it("escalates an exhausted budget to critical and directed", async () => {
    await notifyCostBudgetThreshold(verdict({ level: "exceeded", usedUsd: 12, ratio: 1.2 }), NOW)
    const input = notifyMock.mock.calls[0][0] as Record<string, unknown>
    // It is blocking work until a human answers, so it belongs on the badge.
    expect(input).toMatchObject({ level: "critical", directed: true })
    expect(input.title).toContain("exhausted")
    expect(input.body).toBe("$12.00 of $10.00 used.")
  })

  it("names the provider on a per-provider scope", async () => {
    await notifyCostBudgetThreshold(
      verdict({ scopeKey: "month:anthropic", period: "month", target: "anthropic" }),
      NOW
    )
    expect(notifyMock.mock.calls[0][0].title).toContain("Monthly budget for anthropic")
  })

  it("dedupes per scope per level per day", async () => {
    await notifyCostBudgetThreshold(verdict(), NOW)
    // The same 95% warning must not re-fire every turn, but should tomorrow.
    expect(notifyMock.mock.calls[0][0].dedupeKey).toBe("cost-budget:day:*:critical:2026-08-18")
  })

  it("says nothing for an ok scope", async () => {
    await notifyCostBudgetThreshold(verdict({ level: "ok" }), NOW)
    expect(notifyMock).not.toHaveBeenCalled()
  })
})

describe("requestCostBudgetOverride", () => {
  it("opens a budget gate and resolves approved", async () => {
    const pending = requestCostBudgetOverride(verdict({ level: "exceeded" }), { runId: "run-1" })
    const gate = usePendingGatesStore.getState().gates[0]
    expect(gate).toMatchObject({
      gateType: "budget",
      key: { scope: COST_BUDGET_APPROVAL_SCOPE, id: "day:*" },
      runId: "run-1",
    })
    approve(costBudgetApprovalKey("day:*"))
    await expect(pending).resolves.toEqual({ approved: true, scopeKey: "day:*" })
    // The gate closes either way so the modal host does not keep it open.
    expect(usePendingGatesStore.getState().gates).toHaveLength(0)
  })

  it("resolves not-approved on rejection", async () => {
    const pending = requestCostBudgetOverride(verdict({ level: "exceeded" }))
    reject(costBudgetApprovalKey("day:*"), "too expensive")
    await expect(pending).resolves.toEqual({ approved: false, scopeKey: "day:*" })
  })

  it("resolves not-approved when the caller aborts", async () => {
    const controller = new AbortController()
    const pending = requestCostBudgetOverride(verdict({ level: "exceeded" }), {
      signal: controller.signal,
    })
    controller.abort()
    // A caller that gave up waiting must never be told the spend was authorised.
    await expect(pending).resolves.toEqual({ approved: false, scopeKey: "day:*" })
    expect(usePendingGatesStore.getState().gates).toHaveLength(0)
  })
})

describe("project scope labels", () => {
  afterEach(() => useProjectStore.setState({ projects: [] }))

  it("names the workspace in a project budget notification", async () => {
    useProjectStore.setState({
      projects: [{ id: "alpha", name: "Billing" } as never],
    })
    await notifyCostBudgetThreshold(
      verdict({ scopeKey: "day:project:alpha", target: "project:alpha" }),
      NOW
    )
    expect(notifyMock.mock.calls[0][0].title).toBe("Daily budget for workspace Billing at 95.0%")
  })

  it("falls back to the id for an unknown workspace", async () => {
    await notifyCostBudgetThreshold(
      verdict({ scopeKey: "month:project:gone", period: "month", target: "project:gone" }),
      NOW
    )
    expect(notifyMock.mock.calls[0][0].title).toBe("Monthly budget for workspace gone at 95.0%")
  })
})
