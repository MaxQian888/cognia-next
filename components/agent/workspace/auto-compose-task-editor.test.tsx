/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { AutoComposeTaskEditor } from "./auto-compose-task-editor"
import type { ProposedTask, ProposedTeammate } from "@/lib/ai/agent/team/auto/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Render shadcn Select as a native <select> keyed by task index.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) =>
    React.createElement(
      "select",
      { value, onChange: (e: { target: { value: string } }) => onValueChange(e.target.value) },
      children
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
    React.createElement("option", { value }, children),
}))

const roster = (): ProposedTeammate[] => [
  { name: "Lead", role: "lead", description: "l" },
  { name: "Worker", role: "teammate", description: "w" },
]
const tasks = (): ProposedTask[] => [
  { title: "First", description: "a", assignedTo: 0, dependencies: [] },
  { title: "Second", description: "b", assignedTo: 1, dependencies: [0] },
]

function setup(t = tasks(), r = roster()) {
  const onChange = jest.fn()
  const onAdd = jest.fn()
  const onRemove = jest.fn()
  render(
    <AutoComposeTaskEditor
      tasks={t}
      roster={r}
      onChange={onChange}
      onAdd={onAdd}
      onRemove={onRemove}
    />
  )
  return { onChange, onAdd, onRemove }
}

describe("AutoComposeTaskEditor", () => {
  it("renders a card per task; the first has no dependency toggles", () => {
    setup()
    expect(screen.getByTestId("auto-compose-task-0")).toBeInTheDocument()
    expect(screen.getByTestId("auto-compose-task-1")).toBeInTheDocument()
    // Task 0 cannot depend on anything; task 1 can depend on #0.
    expect(screen.queryByTestId("auto-compose-task-0-dep-0")).not.toBeInTheDocument()
    expect(screen.getByTestId("auto-compose-task-1-dep-0")).toBeInTheDocument()
  })

  it("reports title edits immutably", () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByTestId("auto-compose-task-title-0"), {
      target: { value: "Renamed" },
    })
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ title: "Renamed" }),
      expect.objectContaining({ title: "Second" }),
    ])
  })

  it("reports description edits immutably", () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByTestId("auto-compose-task-desc-1"), {
      target: { value: "new details" },
    })
    expect(onChange).toHaveBeenCalledWith([
      expect.anything(),
      expect.objectContaining({ description: "new details" }),
    ])
  })

  it("reassigns a task to a different roster member", () => {
    const { onChange } = setup()
    // The first <select> belongs to task 0 (currently assigned to 0 → reassign to 1).
    const selects = screen.getAllByRole("combobox")
    fireEvent.change(selects[0], { target: { value: "1" } })
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ assignedTo: 1 }),
      expect.anything(),
    ])
  })

  it("toggles a dependency on and keeps the list sorted", () => {
    const threeTasks: ProposedTask[] = [
      { title: "t0", description: "", assignedTo: 0, dependencies: [] },
      { title: "t1", description: "", assignedTo: 0, dependencies: [] },
      { title: "t2", description: "", assignedTo: 0, dependencies: [1] },
    ]
    const { onChange } = setup(threeTasks)
    // Add dependency #0 to task 2 (already depends on #1) → sorted [0, 1].
    fireEvent.click(screen.getByTestId("auto-compose-task-2-dep-0"))
    expect(onChange).toHaveBeenCalledWith([
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ dependencies: [0, 1] }),
    ])
  })

  it("toggles a dependency off", () => {
    const { onChange } = setup()
    // Task 1 depends on #0 → toggling removes it.
    fireEvent.click(screen.getByTestId("auto-compose-task-1-dep-0"))
    expect(onChange).toHaveBeenCalledWith([
      expect.anything(),
      expect.objectContaining({ dependencies: [] }),
    ])
  })

  it("delegates add / remove to the dialog", () => {
    const { onAdd, onRemove } = setup()
    fireEvent.click(screen.getByTestId("auto-compose-add-task"))
    expect(onAdd).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("auto-compose-remove-task-1"))
    expect(onRemove).toHaveBeenCalledWith(1)
  })
})
