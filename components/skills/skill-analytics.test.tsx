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
// container so the cards render predictably.
jest.mock("recharts", () => ({
  __esModule: true,
  Bar: () => null,
  BarChart: () => null,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Line: () => null,
  LineChart: () => null,
}))

import { render, screen } from "@testing-library/react"
import { SkillAnalytics } from "./skill-analytics"

beforeEach(() => {
  analyticsRef.current = emptyAnalytics()
})

describe("SkillAnalytics", () => {
  it("shows a localized loading state, not the literal 'Loading…' string", () => {
    render(<SkillAnalytics />)
    expect(screen.getByText("loading")).toBeInTheDocument()
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
  })

  it("renders the four summary cards with localized labels once data loads", () => {
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
  })
})
