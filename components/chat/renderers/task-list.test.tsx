/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TaskList, TaskListItem } from "./task-list"

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
})

describe("TaskList", () => {
  const items = [
    {
      id: "a",
      text: "Parent",
      checked: true,
      children: [
        { id: "a1", text: "Child done", checked: true },
        { id: "a2", text: "Child todo", checked: false },
      ],
    },
    { id: "b", text: "Sibling", checked: false },
  ]

  it("renders nested items and a progress summary counting all leaves", () => {
    render(<TaskList items={items} showProgress />)
    expect(screen.getByText("Parent")).toBeInTheDocument()
    expect(screen.getByText("Child done")).toBeInTheDocument()
    expect(screen.getByText("Sibling")).toBeInTheDocument()
    // 2 of 4 flattened items are checked → 50%.
    expect(screen.getByText("Progress")).toBeInTheDocument()
    expect(screen.getByText("2 / 4 (50%)")).toBeInTheDocument()
  })

  it("omits the progress bar when showProgress is false", () => {
    render(<TaskList items={items} />)
    expect(screen.queryByText("Progress")).not.toBeInTheDocument()
  })

  it("is non-interactive by default — no checkbox role, no toggle", async () => {
    const onToggle = jest.fn()
    render(<TaskList items={[{ id: "x", text: "X", checked: false }]} onToggle={onToggle} />)
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  })

  it("toggles via onToggle when interactive", async () => {
    const user = userEvent.setup()
    const onToggle = jest.fn()
    render(
      <TaskList items={[{ id: "x", text: "X", checked: false }]} interactive onToggle={onToggle} />
    )
    await user.click(screen.getByRole("checkbox"))
    expect(onToggle).toHaveBeenCalledWith("x", true)
  })

  it("supports the circle variant", () => {
    const { container } = render(
      <TaskList items={[{ id: "x", text: "X", checked: true }]} variant="circle" />
    )
    // circle variant uses lucide CheckCircle2 (an svg), not the square glyph.
    expect(container.querySelector("svg")).toBeInTheDocument()
  })
})
