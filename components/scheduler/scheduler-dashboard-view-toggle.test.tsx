/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const setView = jest.fn()
const state = { view: "overview" as "overview" | "calendar" | "timeline" }
jest.mock("@/hooks/scheduler/use-scheduler-dashboard-view", () => ({
  __esModule: true,
  useSchedulerDashboardView: () => ({ view: state.view, setView }),
  isSchedulerDashboardView: (v: string) => ["overview", "calendar", "timeline"].includes(v),
}))

import { SchedulerDashboardViewToggle } from "./scheduler-dashboard-view-toggle"

beforeEach(() => {
  setView.mockClear()
  state.view = "overview"
})

describe("SchedulerDashboardViewToggle", () => {
  it("renders the three modes", () => {
    render(<SchedulerDashboardViewToggle />)
    expect(screen.getByTestId("scheduler-dashboard-view-overview")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-dashboard-view-calendar")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-dashboard-view-timeline")).toBeInTheDocument()
  })

  it("persists the chosen mode on click", () => {
    render(<SchedulerDashboardViewToggle />)
    fireEvent.click(screen.getByTestId("scheduler-dashboard-view-timeline"))
    expect(setView).toHaveBeenCalledWith("timeline")
  })

  it("reflects the active mode via aria-pressed/data-state", () => {
    state.view = "calendar"
    render(<SchedulerDashboardViewToggle />)
    expect(screen.getByTestId("scheduler-dashboard-view-calendar")).toHaveAttribute(
      "data-state",
      "on"
    )
  })
})
