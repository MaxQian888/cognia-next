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
    fireEvent.click(screen.getByText("Clear filters"))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })
})
