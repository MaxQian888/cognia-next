/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/hooks/skills", () => ({
  useSkillAnalytics: () => ({
    usageByDay: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      count: i,
    })),
  }),
}))

// Recharts pulls heavy SVG primitives; stub everything to leaf divs so we can
// assert structure without a layout engine.
jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="rc-container">{children}</div>
  ),
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="rc-linechart">{children}</div>
  ),
  Line: () => <div data-testid="rc-line" />,
  XAxis: () => <div data-testid="rc-xaxis" />,
  YAxis: () => <div data-testid="rc-yaxis" />,
  Tooltip: () => <div data-testid="rc-tooltip" />,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillUsageTrend } from "./skill-usage-trend"

describe("SkillUsageTrend", () => {
  it("renders the chart with the title", () => {
    render(<SkillUsageTrend />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByTestId("rc-linechart")).toBeInTheDocument()
  })

  it("provides a 7d / 30d toggle", () => {
    render(<SkillUsageTrend />)
    expect(screen.getByRole("radio", { name: "window7" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "window30" })).toBeInTheDocument()
  })

  it("does not throw when the 30-day toggle is clicked", () => {
    render(<SkillUsageTrend />)
    fireEvent.click(screen.getByRole("radio", { name: "window30" }))
    expect(screen.getByTestId("skill-usage-trend")).toBeInTheDocument()
  })
})
