/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { SchedulerSkeleton } from "./scheduler-skeleton"

describe("SchedulerSkeleton", () => {
  it("renders the full skeleton (sidebar + dashboard) by default", () => {
    render(<SchedulerSkeleton />)
    expect(screen.getByTestId("scheduler-skeleton-full")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-skeleton-sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-skeleton-dashboard")).toBeInTheDocument()
  })

  it("renders only the sidebar skeleton when variant=sidebar", () => {
    render(<SchedulerSkeleton variant="sidebar" />)
    expect(screen.getByTestId("scheduler-skeleton-sidebar")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-skeleton-full")).not.toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-skeleton-dashboard")).not.toBeInTheDocument()
  })

  it("renders only the dashboard skeleton when variant=dashboard", () => {
    render(<SchedulerSkeleton variant="dashboard" />)
    expect(screen.getByTestId("scheduler-skeleton-dashboard")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-skeleton-full")).not.toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-skeleton-sidebar")).not.toBeInTheDocument()
  })

  it("exposes role=status with an accessible label for screen readers", () => {
    render(<SchedulerSkeleton />)
    expect(screen.getByRole("status", { name: /loading scheduler/i })).toBeInTheDocument()
  })
})
