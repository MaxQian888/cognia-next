/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { DndContext } from "@dnd-kit/core"
import { WorkflowFolderDroppable } from "./workflow-folder-droppable"

describe("WorkflowFolderDroppable", () => {
  it("wraps its child as a drop target keyed by folder id", () => {
    render(
      <DndContext>
        <WorkflowFolderDroppable folderId="wff_a">
          <span>folder body</span>
        </WorkflowFolderDroppable>
      </DndContext>
    )
    expect(screen.getByTestId("folder-drop-wff_a")).toBeInTheDocument()
    expect(screen.getByText("folder body")).toBeInTheDocument()
  })
})
