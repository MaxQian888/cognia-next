/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { AgentTeamTasks } from "./tasks"
import type { AgentTeamTask } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) => {
    const state = {
      createTask: () => {},
      deleteTask: () => {},
    }
    return selector(state)
  },
}))

jest.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
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
    render(<AgentTeamTasks teamId="t1" tasks={[]} teammates={[]} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders a card per task with status badge", () => {
    render(
      <AgentTeamTasks
        teamId="t1"
        tasks={[
          makeTask("a", { status: "completed", result: "ok" }),
          makeTask("b", { status: "failed", error: "boom" }),
        ]}
        teammates={[]}
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
        teamId="t1"
        tasks={[
          makeTask("a", { status: "completed", result: "all good" }),
          makeTask("b", { status: "failed", error: "kaboom" }),
        ]}
        teammates={[]}
      />
    )
    expect(screen.getByText("all good")).toBeInTheDocument()
    expect(screen.getByText("kaboom")).toBeInTheDocument()
  })
})
