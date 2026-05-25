/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { DndContext } from "@dnd-kit/core"
import { WorkflowDraggable } from "./workflow-draggable"

describe("WorkflowDraggable", () => {
  it("wraps its child and exposes a stable test id", () => {
    render(
      <DndContext>
        <WorkflowDraggable id="wf_a">
          <span>card body</span>
        </WorkflowDraggable>
      </DndContext>
    )
    expect(screen.getByTestId("workflow-draggable-wf_a")).toBeInTheDocument()
    expect(screen.getByText("card body")).toBeInTheDocument()
  })
})
