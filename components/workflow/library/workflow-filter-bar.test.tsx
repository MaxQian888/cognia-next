/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WorkflowFilterBar } from "./workflow-filter-bar"
import { DEFAULT_WORKFLOW_FILTERS, useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(() => {
  useWorkflowLibraryStore.setState({ filters: { ...DEFAULT_WORKFLOW_FILTERS } })
})

describe("WorkflowFilterBar", () => {
  it("shows no active-count badge with default filters", () => {
    render(<WorkflowFilterBar />)
    expect(screen.getByTestId("workflow-filter-trigger").textContent).not.toMatch(/\d/)
  })

  it("sets the type facet from the dropdown", async () => {
    const user = userEvent.setup()
    render(<WorkflowFilterBar />)
    await user.click(screen.getByTestId("workflow-filter-trigger"))
    fireEvent.click(await screen.findByTestId("workflow-filter-type-user"))
    expect(useWorkflowLibraryStore.getState().filters.type).toBe("user")
  })

  it("toggles the has-trigger boolean", async () => {
    const user = userEvent.setup()
    render(<WorkflowFilterBar />)
    await user.click(screen.getByTestId("workflow-filter-trigger"))
    fireEvent.click(await screen.findByTestId("workflow-filter-has-trigger"))
    expect(useWorkflowLibraryStore.getState().filters.hasTrigger).toBe(true)
  })

  it("shows a count badge and clears all filters", async () => {
    const user = userEvent.setup()
    useWorkflowLibraryStore.setState({
      filters: { type: "template", hasTrigger: true, recentlyFailed: false },
    })
    render(<WorkflowFilterBar />)
    expect(screen.getByTestId("workflow-filter-trigger").textContent).toMatch(/2/)
    await user.click(screen.getByTestId("workflow-filter-trigger"))
    fireEvent.click(await screen.findByTestId("workflow-filter-clear"))
    expect(useWorkflowLibraryStore.getState().filters).toEqual(DEFAULT_WORKFLOW_FILTERS)
  })
})
