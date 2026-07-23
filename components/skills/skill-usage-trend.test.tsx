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
// assert structure without a layout engine. The ResponsiveContainer stub also
// records the props it receives so we can assert a positive `initialDimension`
// is passed (guards against the width(-1)/height(-1) mount flash — see below).
jest.mock("recharts", () => {
  const captured: {
    initialDimension?: { width: number; height: number }
    minWidth?: number
    minHeight?: number
  }[] = []
  return {
    __captured: captured,
    ResponsiveContainer: ({
      children,
      initialDimension,
      minWidth,
      minHeight,
    }: {
      children: React.ReactNode
      initialDimension?: { width: number; height: number }
      minWidth?: number
      minHeight?: number
    }) => {
      captured.push({ initialDimension, minWidth, minHeight })
      return <div data-testid="rc-container">{children}</div>
    },
    LineChart: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="rc-linechart">{children}</div>
    ),
    Line: () => <div data-testid="rc-line" />,
    XAxis: () => <div data-testid="rc-xaxis" />,
    YAxis: () => <div data-testid="rc-yaxis" />,
    Tooltip: () => <div data-testid="rc-tooltip" />,
  }
})

import { fireEvent, render, screen } from "@testing-library/react"
import { SkillUsageTrend } from "./skill-usage-trend"

const rechartsMock = jest.requireMock("recharts") as {
  __captured: {
    initialDimension?: { width: number; height: number }
    minWidth?: number
    minHeight?: number
  }[]
}

beforeEach(() => {
  rechartsMock.__captured.length = 0
})

describe("SkillUsageTrend", () => {
  it("renders the chart with the title", () => {
    render(<SkillUsageTrend />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByTestId("rc-linechart")).toBeInTheDocument()
  })

  // Regression: without a positive `initialDimension`, recharts seeds the
  // container at {-1,-1} and, on every remount (each skills-tab switch),
  // renders nothing for a frame while logging "The width(-1) and height(-1)
  // of chart should be greater than 0" — the source of the tab-switch jitter.
  it("gives ResponsiveContainer a positive initialDimension to avoid the width(-1) mount flash", () => {
    render(<SkillUsageTrend />)
    const dim = rechartsMock.__captured[0]?.initialDimension
    expect(dim).toBeDefined()
    expect(dim!.width).toBeGreaterThan(0)
    expect(dim!.height).toBeGreaterThan(0)
    expect(rechartsMock.__captured[0]?.minWidth).toBe(1)
    expect(rechartsMock.__captured[0]?.minHeight).toBe(1)
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
