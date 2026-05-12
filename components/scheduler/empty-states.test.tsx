/** @jest-environment jsdom */

import { render, screen, fireEvent } from "@testing-library/react"
import { TaskListEmptyState, PanelErrorState } from "./empty-states"

describe("TaskListEmptyState", () => {
  it("renders the empty variant with the create CTA", () => {
    const onCreate = jest.fn()
    render(<TaskListEmptyState onCreate={onCreate} />)
    expect(screen.getByTestId("scheduler-empty-state")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-empty-state-filtered")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("scheduler-empty-create"))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it("renders without the CTA when no onCreate is supplied", () => {
    render(<TaskListEmptyState />)
    expect(screen.queryByTestId("scheduler-empty-create")).not.toBeInTheDocument()
  })

  it("renders the filtered variant with the clear-filters CTA", () => {
    const onClearFilters = jest.fn()
    render(<TaskListEmptyState variant="filtered" onClearFilters={onClearFilters} />)
    expect(screen.getByTestId("scheduler-empty-state-filtered")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("scheduler-empty-clear-filters"))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })

  it("filtered variant omits the clear-filters button when no callback is supplied", () => {
    render(<TaskListEmptyState variant="filtered" />)
    expect(screen.queryByTestId("scheduler-empty-clear-filters")).not.toBeInTheDocument()
  })
})

describe("PanelErrorState", () => {
  it("renders as a role=alert", () => {
    render(<PanelErrorState />)
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByTestId("scheduler-panel-error")).toBeInTheDocument()
  })

  it("uses custom title + description when provided", () => {
    render(<PanelErrorState title="Custom title" description="Custom body" />)
    expect(screen.getByText("Custom title")).toBeInTheDocument()
    expect(screen.getByText("Custom body")).toBeInTheDocument()
  })

  it("invokes onRetry when the retry button is clicked", () => {
    const onRetry = jest.fn()
    render(<PanelErrorState onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId("scheduler-panel-error-retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("omits the retry button when no callback is supplied", () => {
    render(<PanelErrorState />)
    expect(screen.queryByTestId("scheduler-panel-error-retry")).not.toBeInTheDocument()
  })
})
