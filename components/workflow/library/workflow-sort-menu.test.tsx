/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WorkflowSortMenu } from "./workflow-sort-menu"
import { useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(() => {
  useWorkflowLibraryStore.setState({ sort: "updated" })
})

describe("WorkflowSortMenu", () => {
  it("updates the store sort mode when an option is chosen", async () => {
    const user = userEvent.setup()
    render(<WorkflowSortMenu />)
    await user.click(screen.getByTestId("workflow-sort-trigger"))
    fireEvent.click(await screen.findByTestId("workflow-sort-nameAsc"))
    expect(useWorkflowLibraryStore.getState().sort).toBe("nameAsc")
  })

  it("offers every sort mode", async () => {
    const user = userEvent.setup()
    render(<WorkflowSortMenu />)
    await user.click(screen.getByTestId("workflow-sort-trigger"))
    for (const mode of ["nameAsc", "nameDesc", "updated", "created", "runCount"]) {
      expect(await screen.findByTestId(`workflow-sort-${mode}`)).toBeInTheDocument()
    }
  })
})
