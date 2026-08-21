/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SchedulerOverviewSummary, successRateTone } from "./scheduler-overview-summary"
import type { UnifiedStatistics } from "@/lib/scheduler/unified-filter"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

const zeroKinds: Record<ScheduledItemKind, number> = {
  app: 0,
  workflow: 0,
  backup: 0,
  plugin: 0,
  system: 0,
  connector: 0,
}

const stats: UnifiedStatistics = {
  totalItems: 10,
  activeItems: 6,
  pausedItems: 2,
  otherItems: 2,
  totalRuns: 100,
  successfulRuns: 95,
  failedRuns: 5,
  successRate: 95,
  reportingItems: 4,
  countsByKind: { ...zeroKinds, app: 4, workflow: 2, backup: 1, system: 3 },
  activeCountsByKind: { ...zeroKinds, app: 2, system: 1 },
}

function setup(
  overrides: Partial<UnifiedStatistics> = {},
  props: Partial<React.ComponentProps<typeof SchedulerOverviewSummary>> = {}
) {
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
  it("counts every source in the headline, not just app tasks", () => {
    setup()
    expect(screen.getByTestId("summary-total-items")).toHaveTextContent("10")
    expect(screen.getByTestId("summary-success-rate")).toHaveTextContent("95%")
  })

  it("sizes the composition bar by each status share", () => {
    setup()
    expect(screen.getByTestId("summary-bar-active")).toHaveStyle({ width: "60%" })
    expect(screen.getByTestId("summary-bar-paused")).toHaveStyle({ width: "20%" })
  })

  it("says '—' rather than a red 0% when nothing has ever run", () => {
    setup({ successRate: null, totalRuns: 0, successfulRuns: 0, failedRuns: 0, reportingItems: 0 })
    const rate = screen.getByTestId("summary-success-rate")
    expect(rate).toHaveTextContent("—")
    expect(rate).not.toHaveClass("text-red-500")
    expect(screen.getByTestId("summary-no-runs")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0")
  })

  it("still shows a real 0% when every recorded run failed", () => {
    setup({ successRate: 0, totalRuns: 4, successfulRuns: 0, failedRuns: 4 })
    const rate = screen.getByTestId("summary-success-rate")
    expect(rate).toHaveTextContent("0%")
    expect(rate).toHaveClass("text-red-500")
    expect(screen.queryByTestId("summary-no-runs")).toBeNull()
  })

  it("guards against a zero item total instead of dividing by it", () => {
    setup({ totalItems: 0, activeItems: 0, pausedItems: 0, otherItems: 0 })
    expect(screen.getByTestId("summary-bar-active")).toHaveStyle({ width: "0%" })
  })

  it("shows the idle legend only when items are neither active nor paused", () => {
    const { unmount } = setup()
    expect(screen.getByText("statuses.disabled")).toBeInTheDocument()
    unmount()
    setup({ totalItems: 8, activeItems: 6, pausedItems: 2, otherItems: 0 })
    expect(screen.queryByText("statuses.disabled")).toBeNull()
  })

  it("applies the red tone to a low success rate", () => {
    setup({ successRate: 50 })
    expect(screen.getByTestId("summary-success-rate")).toHaveClass("text-red-500")
  })

  it("always renders the kind rail, marking kinds with no items as empty", () => {
    setup()
    expect(screen.getByTestId("kind-summary-strip")).toBeInTheDocument()
    expect(screen.getByTestId("kind-summary-app")).toHaveTextContent("4")
    expect(screen.getByTestId("kind-summary-plugin")).toHaveTextContent("0")
    // Only kinds with active items surface the green active count.
    expect(screen.getByTestId("kind-summary-app")).toHaveTextContent("active")
    expect(screen.getByTestId("kind-summary-workflow")).not.toHaveTextContent("active")
  })

  it("leaves the rail inert when no kind handler is supplied", () => {
    setup()
    expect(screen.getByTestId("kind-summary-app").tagName).toBe("SPAN")
  })

  it("turns the rail into filter buttons when a handler is supplied", () => {
    const onSelectKind = jest.fn()
    setup({}, { onSelectKind })
    const app = screen.getByTestId("kind-summary-app")
    expect(app.tagName).toBe("BUTTON")
    fireEvent.click(app)
    expect(onSelectKind).toHaveBeenCalledWith("app")
  })

  it("marks the kinds already pinned in the sidebar filter", () => {
    setup({}, { onSelectKind: jest.fn(), selectedKinds: new Set<ScheduledItemKind>(["workflow"]) })
    expect(screen.getByTestId("kind-summary-workflow")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("kind-summary-app")).toHaveAttribute("aria-pressed", "false")
  })
})
