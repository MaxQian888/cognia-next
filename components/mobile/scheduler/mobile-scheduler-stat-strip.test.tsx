/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import type { TaskStatistics } from "@/types/scheduler"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { MobileSchedulerStatStrip } from "./mobile-scheduler-stat-strip"

function makeStats(overrides: Partial<TaskStatistics> = {}): TaskStatistics {
  return {
    totalTasks: 5,
    activeTasks: 3,
    pausedTasks: 1,
    totalExecutions: 20,
    successfulExecutions: 18,
    failedExecutions: 2,
    averageDuration: 1200,
    upcomingExecutions: 2,
    ...overrides,
  }
}

describe("MobileSchedulerStatStrip", () => {
  it("returns null when statistics is null", () => {
    const { container } = render(<MobileSchedulerStatStrip statistics={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the four stat cells with values from statistics", () => {
    render(<MobileSchedulerStatStrip statistics={makeStats()} />)
    expect(screen.getByTestId("mobile-scheduler-stat-strip")).toBeInTheDocument()
    expect(screen.getByTestId("stat-active")).toHaveTextContent("3")
    expect(screen.getByTestId("stat-paused")).toHaveTextContent("1")
    expect(screen.getByTestId("stat-executions")).toHaveTextContent("20")
    // 18/20 → 90% → green tier
    expect(screen.getByTestId("stat-success")).toHaveTextContent("90%")
  })

  it("renders 0% success when no executions yet (no division by zero)", () => {
    render(
      <MobileSchedulerStatStrip
        statistics={makeStats({
          totalExecutions: 0,
          successfulExecutions: 0,
        })}
      />
    )
    expect(screen.getByTestId("stat-success")).toHaveTextContent("0%")
  })

  it("uses red tier styling when success rate is below 70%", () => {
    render(
      <MobileSchedulerStatStrip
        statistics={makeStats({ totalExecutions: 10, successfulExecutions: 5 })}
      />
    )
    const cell = screen.getByTestId("stat-success")
    expect(cell.textContent).toContain("50%")
    expect(cell.querySelector(".text-red-500")).toBeInTheDocument()
  })

  it("uses yellow tier styling when success rate is 70-89%", () => {
    render(
      <MobileSchedulerStatStrip
        statistics={makeStats({ totalExecutions: 10, successfulExecutions: 8 })}
      />
    )
    const cell = screen.getByTestId("stat-success")
    expect(cell.textContent).toContain("80%")
    expect(cell.querySelector(".text-yellow-500")).toBeInTheDocument()
  })

  it("applies passed-in className alongside the strip defaults", () => {
    render(<MobileSchedulerStatStrip statistics={makeStats()} className="ring-2" />)
    expect(screen.getByTestId("mobile-scheduler-stat-strip")).toHaveClass("ring-2")
    expect(screen.getByTestId("mobile-scheduler-stat-strip")).toHaveClass("overflow-x-auto")
  })
})
