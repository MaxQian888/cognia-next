/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { WorkflowLibraryEmpty } from "./workflow-library-empty"

describe("WorkflowLibraryEmpty", () => {
  it("renders the root empty state and fires onCreate", () => {
    const onCreate = jest.fn()
    render(<WorkflowLibraryEmpty variant="root" onCreate={onCreate} />)
    expect(screen.getByTestId("workflow-empty-root")).toBeInTheDocument()
    expect(screen.getByText("No workflows yet")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Create workflow"))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it("renders the empty-folder copy", () => {
    render(<WorkflowLibraryEmpty variant="folder" onCreate={jest.fn()} />)
    expect(screen.getByTestId("workflow-empty-folder")).toBeInTheDocument()
    expect(screen.getByText("This folder is empty")).toBeInTheDocument()
  })

  it("renders the filtered state and fires onClearFilters", () => {
    const onClearFilters = jest.fn()
    render(<WorkflowLibraryEmpty variant="filtered" onClearFilters={onClearFilters} />)
    expect(screen.getByTestId("workflow-empty-filtered")).toBeInTheDocument()
    expect(screen.getByText("No matching workflows")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Clear filters"))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })

  it("names the search query when it is what hides every workflow", () => {
    const onClearFilters = jest.fn()
    render(
      <WorkflowLibraryEmpty variant="filtered" query="  digest  " onClearFilters={onClearFilters} />
    )
    const panel = screen.getByTestId("workflow-empty-filtered")
    expect(panel).toHaveAttribute("data-search-active", "true")
    expect(screen.getByText("No workflows match “digest”")).toBeInTheDocument()
    expect(
      screen.getByText("Your search is hiding every workflow here. Clear it to see them all.")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })

  it("mentions the active facet filters alongside the search", () => {
    render(
      <WorkflowLibraryEmpty
        variant="filtered"
        query="digest"
        activeFilterCount={2}
        onClearFilters={jest.fn()}
      />
    )
    expect(
      screen.getByText("Your search and 2 filters are hiding every workflow here.")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear search and filters" })).toBeInTheDocument()
  })

  it("elides a very long search query in the title", () => {
    render(<WorkflowLibraryEmpty variant="filtered" query={"x".repeat(80)} />)
    expect(screen.getByText(`No workflows match “${"x".repeat(60)}…”`)).toBeInTheDocument()
  })

  it("ignores a whitespace-only query and keeps the facet copy", () => {
    render(<WorkflowLibraryEmpty variant="filtered" query="   " activeFilterCount={1} />)
    expect(screen.getByTestId("workflow-empty-filtered")).not.toHaveAttribute("data-search-active")
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument()
  })
})
