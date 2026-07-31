/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PlanModeTasksSheet } from "./plan-mode-tasks-sheet"
import { getDb } from "@/lib/db/schema"
import { upsertRunRecord, type RunRecordRow } from "@/lib/db/run-records"
import type { TodoEntry } from "@/lib/chat/todos"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

function record(sessionId: string, todos: TodoEntry[]): RunRecordRow {
  return {
    sessionId,
    runId: 1,
    startedAt: 100,
    status: "done",
    tools: [],
    subagents: [],
    todos,
    todoCounts: { done: todos.filter((t) => t.status === "completed").length, total: todos.length },
    counts: { tools: 0, subagents: 0 },
  }
}

beforeEach(async () => {
  await getDb().runRecords.clear()
})

describe("PlanModeTasksSheet", () => {
  it("renders nothing when the latest run record has no todos", async () => {
    const { container } = render(<PlanModeTasksSheet sessionId="s1" />)
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it("shows a trigger labelled with the todo count when todos exist", async () => {
    await upsertRunRecord(
      record("s1", [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ])
    )
    render(<PlanModeTasksSheet sessionId="s1" />)
    const trigger = await screen.findByTestId("plan-mode-tasks-trigger")
    expect(trigger.getAttribute("aria-label")).toContain('"count":2')
  })

  it("opening the sheet renders the durable todo list", async () => {
    await upsertRunRecord(record("s1", [{ content: "do the thing", status: "pending" }]))
    const user = userEvent.setup()
    render(<PlanModeTasksSheet sessionId="s1" />)
    await user.click(await screen.findByTestId("plan-mode-tasks-trigger"))
    expect(screen.getByText("do the thing")).toBeInTheDocument()
  })
})
