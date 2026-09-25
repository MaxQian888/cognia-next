/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

const liveTask = jest.fn()
jest.mock("@/hooks/scheduler/use-live-scheduled-task", () => ({
  useLiveScheduledTask: (id: string | null | undefined) => liveTask(id),
}))
// The code block is a Shiki renderer; its contents are not what is under test.
jest.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
}))

import {
  isScheduleApprovalTool,
  ScheduledTaskApprovalPreview,
} from "./scheduled-task-approval-preview"

function existing(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "Morning digest",
    type: "chat",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    ...overrides,
  }
}

beforeEach(() => {
  liveTask.mockReset()
  liveTask.mockReturnValue(undefined)
})

describe("isScheduleApprovalTool", () => {
  it("is true for the schedule writes and false for reads and other tools", () => {
    expect(isScheduleApprovalTool("scheduler_create_task")).toBe(true)
    expect(isScheduleApprovalTool("scheduler_delete_task")).toBe(true)
    expect(isScheduleApprovalTool("scheduler_list_tasks")).toBe(false)
    expect(isScheduleApprovalTool("scheduler_inspect_task")).toBe(false)
    expect(isScheduleApprovalTool("Bash")).toBe(false)
  })
})

describe("ScheduledTaskApprovalPreview", () => {
  it("says what a create will add: name, what runs, when, and the next runs", () => {
    render(
      <ScheduledTaskApprovalPreview
        toolName="scheduler_create_task"
        input={{
          name: "Summarise my PRs",
          type: "chat",
          trigger: { type: "cron", cronExpression: "0 9 * * 1-5", timezone: "UTC" },
          payload: { prompt: "Summarise the PRs waiting on me" },
          paused: false,
        }}
      />
    )
    expect(screen.getByText("Add to your schedule")).toBeInTheDocument()
    expect(screen.getByTestId("schedule-approval-name")).toHaveTextContent("Summarise my PRs")
    expect(screen.getByText("Chat")).toBeInTheDocument()
    expect(screen.getByText("Summarise the PRs waiting on me")).toBeInTheDocument()
    expect(screen.getByText(/0 9 \* \* 1-5 · UTC/)).toBeInTheDocument()
    expect(screen.getByTestId("trigger-preview")).toHaveAttribute("data-state", "dates")
    // The task does not exist yet, so nothing is looked up.
    expect(liveTask).toHaveBeenCalledWith(null)
  })

  it("names the task a delete removes instead of showing its id", () => {
    liveTask.mockReturnValue(existing())
    render(
      <ScheduledTaskApprovalPreview toolName="scheduler_delete_task" input={{ taskId: "t1" }} />
    )
    expect(liveTask).toHaveBeenCalledWith("t1")
    expect(screen.getByTestId("schedule-approval-task")).toHaveTextContent("Morning digest")
    expect(screen.getByTestId("schedule-approval-preview")).toHaveAttribute("data-verb", "delete")
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument()
  })

  it("says so when the id points at no task on this device", () => {
    liveTask.mockReturnValue(null)
    render(
      <ScheduledTaskApprovalPreview toolName="scheduler_run_task_now" input={{ taskId: "ghost" }} />
    )
    expect(screen.getByTestId("schedule-approval-missing")).toHaveTextContent("ghost")
  })

  it("shows the status a set_status will move the task to", () => {
    liveTask.mockReturnValue(existing())
    render(
      <ScheduledTaskApprovalPreview
        toolName="scheduler_set_task_status"
        input={{ taskId: "t1", status: "paused" }}
      />
    )
    expect(screen.getByText("New status")).toBeInTheDocument()
    expect(screen.getAllByText("Paused").length).toBeGreaterThan(0)
  })

  it("keeps the raw arguments one click away", () => {
    liveTask.mockReturnValue(existing())
    render(
      <ScheduledTaskApprovalPreview toolName="scheduler_run_task_now" input={{ taskId: "t1" }} />
    )
    expect(screen.getByTestId("schedule-approval-raw")).not.toHaveAttribute("open")
    expect(screen.getByTestId("code-block")).toHaveTextContent('"taskId": "t1"')
  })
})
