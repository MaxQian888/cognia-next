/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const analyticsRef: { current: ReturnType<typeof emptyAnalytics> } = {
  current: emptyAnalytics(),
}
function emptyAnalytics() {
  return {
    loading: true as boolean,
    totalSkills: 0,
    totalEnabled: 0,
    totalUsage: 0,
    estimatedTokens: 0,
    byCategory: [] as { category: string; count: number; usage: number }[],
    mostUsed: [] as { id: string; name: string; category: string; usageCount?: number }[],
    recentlyUsed: [] as { id: string; name: string; lastUsedAt?: number }[],
    neverUsed: [] as { id: string; name: string; source: string }[],
    usageByDay: [] as { date: string; count: number }[],
  }
}
jest.mock("@/hooks/skills", () => ({
  useSkillAnalytics: () => analyticsRef.current,
}))

// recharts touches DOM measurements jsdom doesn't model; stub to a no-op
// container so the flat analytics sections render predictably. The ResponsiveContainer stub
// records `initialDimension` so we can assert every chart is seeded with a
// positive size (guards the width(-1)/height(-1) tab-switch mount flash).
jest.mock("recharts", () => {
  const captured: { initialDimension?: { width: number; height: number } }[] = []
  return {
    __esModule: true,
    __captured: captured,
    Bar: () => null,
    BarChart: () => null,
    CartesianGrid: () => null,
    ResponsiveContainer: ({
      children,
      initialDimension,
    }: {
      children: React.ReactNode
      initialDimension?: { width: number; height: number }
    }) => {
      captured.push({ initialDimension })
      return <div>{children}</div>
    },
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Line: () => null,
    LineChart: () => null,
  }
})

const rechartsMock = jest.requireMock("recharts") as {
  __captured: { initialDimension?: { width: number; height: number } }[]
}

import { render, screen } from "@testing-library/react"
import { SkillAnalytics } from "./skill-analytics"

beforeEach(() => {
  analyticsRef.current = emptyAnalytics()
  rechartsMock.__captured.length = 0
})

describe("SkillAnalytics", () => {
  it("shows a localized loading state, not the literal 'Loading…' string", () => {
    render(<SkillAnalytics />)
    expect(screen.getByText("loading")).toBeInTheDocument()
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
  })

  it("renders the four summary metrics once data loads", () => {
    analyticsRef.current = { ...emptyAnalytics(), loading: false }
    render(<SkillAnalytics />)
    expect(screen.getByText("totalSkills")).toBeInTheDocument()
    expect(screen.getByText("totalEnabled")).toBeInTheDocument()
    expect(screen.getByText("totalUsage")).toBeInTheDocument()
    expect(screen.getByText("tokensEstimated")).toBeInTheDocument()
  })

  it("uses distinct headers for the category-usage chart and the most-used list", () => {
    analyticsRef.current = {
      ...emptyAnalytics(),
      loading: false,
      byCategory: [{ category: "development", count: 1, usage: 5 }],
      mostUsed: [{ id: "s1", name: "Alpha", category: "development", usageCount: 5 }],
    }
    render(<SkillAnalytics />)
    expect(screen.getByText("categoryUsageTitle")).toBeInTheDocument()
    expect(screen.getByText("mostUsedTitle")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeInTheDocument()
  })

  // Regression: every recharts container (category bar chart + the usage-trend
  // line chart) must be seeded with a positive `initialDimension`. Otherwise it
  // starts at {-1,-1} and, on each tab remount, logs "The width(-1) and
  // height(-1) of chart should be greater than 0" and flashes empty — the
  // reported tab-switch jitter.
  it("seeds every chart with a positive initialDimension", () => {
    analyticsRef.current = {
      ...emptyAnalytics(),
      loading: false,
      byCategory: [{ category: "development", count: 1, usage: 5 }],
      usageByDay: [{ date: "2026-05-01", count: 3 }],
    }
    render(<SkillAnalytics />)
    // Category bar chart + usage-trend line chart both render.
    expect(rechartsMock.__captured.length).toBeGreaterThanOrEqual(2)
    for (const cap of rechartsMock.__captured) {
      expect(cap.initialDimension).toBeDefined()
      expect(cap.initialDimension!.width).toBeGreaterThan(0)
      expect(cap.initialDimension!.height).toBeGreaterThan(0)
    }
  })
})
