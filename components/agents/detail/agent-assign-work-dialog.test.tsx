/** @jest-environment jsdom */

// "Assign work" (ADR-0220): the task board's own create form in a dialog, a
// toast and close on create, and a pointer to Issues for issue assignment.

import { act, render, screen } from "@testing-library/react"

import type { AgentTask } from "@/types/agent/agent-task"

const mockToast = { success: jest.fn() }
jest.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => mockToast.success(...args) },
}))

let formProps: { agentId: string; onCreated: (task: AgentTask) => void } | undefined
jest.mock("@/components/agent/agent-task-board", () => ({
  AgentTaskCreateForm: (props: { agentId: string; onCreated: (task: AgentTask) => void }) => {
    formProps = props
    return <div data-testid="create-form-stub" />
  },
}))

import { AgentAssignWorkDialog } from "./agent-assign-work-dialog"

const agent = { id: "char_1", name: "Alpha" }

beforeEach(() => {
  mockToast.success.mockReset()
  formProps = undefined
})

describe("AgentAssignWorkDialog", () => {
  it("renders nothing while closed", () => {
    render(<AgentAssignWorkDialog agent={agent} open={false} onOpenChange={jest.fn()} />)
    expect(screen.queryByTestId("create-form-stub")).not.toBeInTheDocument()
  })

  it("titles the dialog with the agent and binds the form to it", () => {
    render(<AgentAssignWorkDialog agent={agent} open onOpenChange={jest.fn()} />)
    expect(screen.getByRole("dialog")).toHaveTextContent("Alpha")
    expect(formProps?.agentId).toBe("char_1")
    expect(screen.getByRole("link")).toHaveAttribute("href", "/issues")
  })

  it("toasts, closes and reports back once a task is created", () => {
    const onOpenChange = jest.fn()
    const onAssigned = jest.fn()
    render(
      <AgentAssignWorkDialog
        agent={agent}
        open
        onOpenChange={onOpenChange}
        onAssigned={onAssigned}
      />
    )
    act(() => formProps!.onCreated({ title: "Write report" } as AgentTask))
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining("Write report"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onAssigned).toHaveBeenCalledTimes(1)
  })

  it("does not need an onAssigned handler", () => {
    const onOpenChange = jest.fn()
    render(<AgentAssignWorkDialog agent={agent} open onOpenChange={onOpenChange} />)
    expect(() => act(() => formProps!.onCreated({ title: "x" } as AgentTask))).not.toThrow()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
