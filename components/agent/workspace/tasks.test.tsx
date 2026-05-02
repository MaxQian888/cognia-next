/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { AgentTeamTasks } from "./tasks"
import type { AgentTeamTask } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function makeTask(id: string, overrides: Partial<AgentTeamTask> = {}): AgentTeamTask {
  return {
    id,
    teamId: "t1",
    title: `Task ${id}`,
    description: `Desc ${id}`,
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    createdAt: new Date(),
    order: 0,
    ...overrides,
  }
}

describe("AgentTeamTasks", () => {
  it("renders the empty state when no tasks are provided", () => {
    render(<AgentTeamTasks tasks={[]} />)
    expect(screen.getByTestId("tasks-empty")).toBeInTheDocument()
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders a card per task with status badge", () => {
    render(
      <AgentTeamTasks
        tasks={[
          makeTask("a", { status: "completed", result: "ok" }),
          makeTask("b", { status: "failed", error: "boom" }),
        ]}
      />
    )
    expect(screen.getByTestId("task-a")).toBeInTheDocument()
    expect(screen.getByTestId("task-b")).toBeInTheDocument()
    expect(screen.getByTestId("task-a-status").textContent).toContain("completed")
    expect(screen.getByTestId("task-b-status").textContent).toContain("failed")
  })

  it("shows error text for failed tasks and result text for completed tasks", () => {
    render(
      <AgentTeamTasks
        tasks={[
          makeTask("a", { status: "completed", result: "all good" }),
          makeTask("b", { status: "failed", error: "kaboom" }),
        ]}
      />
    )
    expect(screen.getByText("all good")).toBeInTheDocument()
    expect(screen.getByText("kaboom")).toBeInTheDocument()
  })
})
