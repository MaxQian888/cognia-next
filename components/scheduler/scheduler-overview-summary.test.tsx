/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SchedulerOverviewSummary, successRateTone } from "./scheduler-overview-summary"
import type { TaskStatistics } from "@/types/scheduler"

const stats: TaskStatistics = {
  totalTasks: 10,
  activeTasks: 6,
  pausedTasks: 2,
  totalExecutions: 100,
  successfulExecutions: 95,
  failedExecutions: 5,
  averageDuration: 1000,
  upcomingExecutions: 3,
}

function setup(overrides: Partial<TaskStatistics> = {}, props = {}) {
  return render(<SchedulerOverviewSummary statistics={{ ...stats, ...overrides }} {...props} />)
}

describe("successRateTone", () => {
  it("bands green / yellow / red", () => {
    expect(successRateTone(95).text).toBe("text-green-500")
    expect(successRateTone(90).bar).toBe("bg-green-500")
    expect(successRateTone(75).text).toBe("text-yellow-500")
    expect(successRateTone(70).bar).toBe("bg-yellow-500")
    expect(successRateTone(69).text).toBe("text-red-500")
    expect(successRateTone(0).bar).toBe("bg-red-500")
  })
})

describe("SchedulerOverviewSummary", () => {
  it("renders the headline totals and the success rate", () => {
    setup()
    expect(screen.getByText("10")).toBeInTheDocument()
    expect(screen.getByTestId("summary-success-rate")).toHaveTextContent("95%")
    expect(screen.getByTestId("scheduler-overview-summary")).toBeInTheDocument()
  })

  it("sizes the composition bar by each status share", () => {
    setup()
    expect(screen.getByTestId("summary-bar-active")).toHaveStyle({ width: "60%" })
    expect(screen.getByTestId("summary-bar-paused")).toHaveStyle({ width: "20%" })
  })

  it("renders 0% and a zero-width bar when nothing has run", () => {
    setup({ totalExecutions: 0, successfulExecutions: 0, failedExecutions: 0 })
    expect(screen.getByTestId("summary-success-rate")).toHaveTextContent("0%")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
  })

  it("guards against a zero task total instead of dividing by it", () => {
    setup({ totalTasks: 0, activeTasks: 0, pausedTasks: 0 })
    expect(screen.getByTestId("summary-bar-active")).toHaveStyle({ width: "0%" })
  })

  it("shows the idle legend only when tasks are neither active nor paused", () => {
    const { unmount } = setup()
    expect(screen.getByText("statuses.disabled")).toBeInTheDocument()
    unmount()
    setup({ totalTasks: 8, activeTasks: 6, pausedTasks: 2 })
    expect(screen.queryByText("statuses.disabled")).toBeNull()
  })

  it("applies the red tone to a low success rate", () => {
    setup({ totalExecutions: 100, successfulExecutions: 50 })
    expect(screen.getByTestId("summary-success-rate")).toHaveClass("text-red-500")
  })

  it("renders the kind rail when counts are supplied", () => {
    setup(
      {},
      {
        countsByKind: { app: 4, workflow: 2, backup: 1, plugin: 0, system: 3, connector: 0 },
        activeCountsByKind: { app: 2, workflow: 0, backup: 0, plugin: 0, system: 1, connector: 0 },
      }
    )
    expect(screen.getByTestId("kind-summary-strip")).toBeInTheDocument()
    expect(screen.getByTestId("kind-summary-app")).toHaveTextContent("4")
    // Only kinds with active items surface the green active count.
    expect(screen.getByTestId("kind-summary-app")).toHaveTextContent("active")
    expect(screen.getByTestId("kind-summary-workflow")).not.toHaveTextContent("active")
  })

  it("treats a kind missing from the counts as zero", () => {
    setup(
      {},
      {
        countsByKind: { app: 4 } as Record<string, number>,
        activeCountsByKind: undefined,
      }
    )
    expect(screen.getByTestId("kind-summary-workflow")).toHaveTextContent("0")
    expect(screen.getByTestId("kind-summary-app")).not.toHaveTextContent("active")
  })

  it("omits the kind rail when counts are absent", () => {
    setup()
    expect(screen.queryByTestId("kind-summary-strip")).toBeNull()
  })
})
