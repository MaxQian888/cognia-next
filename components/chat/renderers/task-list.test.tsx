/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import * as taskListModule from "./task-list"
import { TaskListItem } from "./task-list"

describe("TaskListItem", () => {
  it("renders an unchecked item with its label", () => {
    render(<TaskListItem checked={false}>Buy milk</TaskListItem>)
    expect(screen.getByText("Buy milk")).toBeInTheDocument()
  })

  it("strikes through a checked item", () => {
    render(<TaskListItem checked>Done thing</TaskListItem>)
    const label = screen.getByText("Done thing")
    expect(label).toHaveClass("line-through")
  })

  it("takes itself out of the list flow so the markdown `ul` marker does not double up", () => {
    // react-markdown still emits the `ul`; the glyph IS the marker here.
    const { container } = render(<TaskListItem checked={false}>Item</TaskListItem>)
    expect(container.querySelector("li")).toHaveClass("list-none")
  })

  it("exports no interactive checklist — TodoWrite's renderer owns that", () => {
    // Pins the removal of the unreachable `TaskList`: it duplicated
    // `components/chat/todo-list.tsx`, its options had no caller, and its row
    // was a `div[role=checkbox]` with no keyboard path. Re-adding a list-level
    // export here should be a deliberate act with a real consumer, not a
    // silent second checklist.
    expect(Object.keys(taskListModule)).toEqual(["TaskListItem"])
  })
})
