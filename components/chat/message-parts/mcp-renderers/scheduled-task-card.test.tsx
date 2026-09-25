/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolUIPart } from "ai"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
const liveTask = jest.fn()
jest.mock("@/hooks/scheduler/use-live-scheduled-task", () => ({
  useLiveScheduledTask: (id: string | undefined) => liveTask(id),
}))

import { SCHEDULE_LIST_CARD_ROWS, SCHEDULED_TASK_CARDS } from "./scheduled-task-card"

function part(output: unknown, input: Record<string, unknown> = {}): ToolUIPart {
  return {
    type: "tool-scheduler_create_task",
    toolCallId: "call-1",
    state: "output-available",
    input,
    output: JSON.stringify(output),
  } as unknown as ToolUIPart
}

function renderCard(name: keyof typeof SCHEDULED_TASK_CARDS, value: ToolUIPart) {
  const Card = SCHEDULED_TASK_CARDS[name]
  const element = Card({ part: value })
  return { element, ...render(<>{element}</>) }
}

const visibleTask = {
  id: "t1",
  name: "Morning digest",
  type: "chat",
  status: "active",
  trigger: { type: "interval", intervalMs: 3_600_000 },
  nextRunAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  runCount: 0,
  successCount: 0,
  failureCount: 0,
}

beforeEach(() => {
  push.mockReset()
  liveTask.mockReset()
  liveTask.mockReturnValue(undefined)
})

describe("scheduled task tool cards", () => {
  it("registers one card per schedule tool", () => {
    expect(Object.keys(SCHEDULED_TASK_CARDS).sort()).toEqual(
      [
        "scheduler_cancel_task_run",
        "scheduler_create_task",
        "scheduler_delete_task",
        "scheduler_inspect_task",
        "scheduler_list_tasks",
        "scheduler_run_task_now",
        "scheduler_set_task_status",
        "scheduler_stop_task_process",
        "scheduler_update_task",
      ].sort()
    )
  })

  it("returns null for anything it does not recognise, so the generic body renders", () => {
    const Card = SCHEDULED_TASK_CARDS.scheduler_create_task
    expect(Card({ part: part("not json at all") })).toBeNull()
    expect(Card({ part: part({ unexpected: true }) })).toBeNull()
    expect(Card({ part: { ...part({}), output: undefined } as ToolUIPart })).toBeNull()
  })

  it("shows a created task and opens it on the scheduler page", async () => {
    const user = userEvent.setup()
    renderCard(
      "scheduler_create_task",
      part({ status: "ok", data: { status: "created", task: visibleTask } })
    )
    expect(screen.getByTestId("schedule-card-task")).toHaveTextContent("Morning digest")
    expect(screen.getByTestId("schedule-card-task")).toHaveTextContent(/next/)
    await user.click(screen.getByTestId("schedule-card-open"))
    expect(push).toHaveBeenCalledWith("/scheduler?item=app%3At1")
  })

  it("follows the live task: a pause made later shows up without a reload", () => {
    liveTask.mockReturnValue({ ...visibleTask, status: "paused", nextRunAt: undefined })
    renderCard(
      "scheduler_create_task",
      part({ status: "ok", data: { status: "created", task: visibleTask } })
    )
    expect(screen.getByTestId("item-status-badge-paused")).toBeInTheDocument()
  })

  it("says a task has since been deleted", () => {
    liveTask.mockReturnValue(null)
    renderCard(
      "scheduler_update_task",
      part({ status: "ok", data: { status: "updated", task: visibleTask } })
    )
    expect(screen.getByTestId("schedule-card-gone")).toBeInTheDocument()
  })

  it("links a run-now result to the run it started", async () => {
    const user = userEvent.setup()
    liveTask.mockReturnValue({ ...visibleTask, trigger: { type: "interval", intervalMs: 60_000 } })
    renderCard(
      "scheduler_run_task_now",
      part(
        {
          status: "ok",
          data: { status: "running", runId: "run-7", startedAt: "2026-09-25T00:00:00Z" },
        },
        { taskId: "t1" }
      )
    )
    expect(screen.getByTestId("run-status-running")).toBeInTheDocument()
    await user.click(screen.getByTestId("schedule-card-open"))
    expect(push).toHaveBeenCalledWith("/scheduler?item=app%3At1&run=app%3Arun-7")
  })

  it("lists tasks as links and counts the rest", () => {
    const tasks = Array.from({ length: SCHEDULE_LIST_CARD_ROWS + 2 }, (_, index) => ({
      ...visibleTask,
      id: `t${index}`,
      name: `Task ${index}`,
    }))
    renderCard(
      "scheduler_list_tasks",
      part({ status: "ok", data: { total: tasks.length, returned: tasks.length, tasks } })
    )
    const rows = screen.getAllByTestId("schedule-card-list-row")
    expect(rows).toHaveLength(SCHEDULE_LIST_CARD_ROWS)
    expect(rows[0].querySelector("a")).toHaveAttribute("href", "/scheduler?item=app%3At0")
    expect(screen.getByText("and 2 more")).toBeInTheDocument()
  })

  it("says what was deleted", () => {
    renderCard(
      "scheduler_delete_task",
      part({ status: "ok", data: { status: "deleted", taskId: "t1", name: "Morning digest" } })
    )
    expect(screen.getByTestId("schedule-card-deleted")).toHaveTextContent("Deleted Morning digest")
  })

  it("shows a refusal in the user's words, the skill's detail folded, and the settings", async () => {
    const user = userEvent.setup()
    renderCard(
      "scheduler_create_task",
      part({ status: "error", message: "Agents are not allowed to manage your schedule." })
    )
    const refusal = screen.getByTestId("schedule-card-refusal")
    expect(refusal).toHaveAttribute("data-reason", "failed")
    expect(refusal).toHaveTextContent("This did not go through.")
    expect(screen.getByTestId("schedule-card-refusal-detail")).not.toHaveAttribute("open")
    expect(screen.getByTestId("schedule-card-refusal-detail")).toHaveTextContent("not allowed")
    await user.click(screen.getByTestId("schedule-card-open"))
    expect(push).toHaveBeenCalledWith("/settings?section=scheduled-tasks")
  })

  it("names a declined dialog as the user's own answer, with no settings to change", () => {
    renderCard(
      "scheduler_delete_task",
      part({
        status: "denied",
        reason: "hitl_rejected",
        message: 'The user declined "schedule.delete".',
      })
    )
    expect(screen.getByTestId("schedule-card-refusal")).toHaveTextContent(
      "You declined this change."
    )
    expect(screen.queryByTestId("schedule-card-open")).not.toBeInTheDocument()
  })

  it("says a stop outcome in its own words, never the text written for the model", () => {
    liveTask.mockReturnValue({ ...visibleTask })
    renderCard(
      "scheduler_cancel_task_run",
      part(
        {
          status: "ok",
          data: {
            status: "already-finished",
            runId: "run-3",
            message: "That run had already finished. Use scheduler_inspect_task…",
          },
        },
        { taskId: "t1", runId: "run-3" }
      )
    )
    expect(screen.getByTestId("schedule-card-outcome")).toHaveTextContent("Already finished")
    expect(screen.queryByText(/scheduler_inspect_task/)).not.toBeInTheDocument()
  })

  it("does not offer settings for a refused read", () => {
    renderCard("scheduler_list_tasks", part({ status: "denied", message: "Not on this channel." }))
    expect(screen.getByTestId("schedule-card-refusal")).toBeInTheDocument()
    expect(screen.queryByTestId("schedule-card-open")).not.toBeInTheDocument()
  })
})
