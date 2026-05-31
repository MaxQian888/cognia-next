/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/ui/scroll-area")

import { TaskDependencyDialog } from "./task-dependency-dialog"
import type { ScheduledTask } from "@/types/scheduler"

function task(id: string, dependsOn?: string[]): ScheduledTask {
  return {
    id,
    name: id.toUpperCase(),
    type: "chat",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 9 * * *", dependsOn },
    config: {
      timeout: 1,
      maxRetries: 0,
      retryDelay: 0,
      runMissedOnStartup: false,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: false, onError: false },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

const tasks = [task("a"), task("b", ["a"])]

describe("TaskDependencyDialog", () => {
  it("renders the full graph when open", () => {
    render(
      <TaskDependencyDialog open onOpenChange={jest.fn()} tasks={tasks} onSelectTask={jest.fn()} />
    )
    expect(screen.getByTestId("task-dependency-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("dependency-node-a")).toBeInTheDocument()
    expect(screen.getByTestId("dependency-node-b")).toBeInTheDocument()
  })

  it("closes and routes when a node is selected", () => {
    const onOpenChange = jest.fn()
    const onSelectTask = jest.fn()
    render(
      <TaskDependencyDialog
        open
        onOpenChange={onOpenChange}
        tasks={tasks}
        onSelectTask={onSelectTask}
      />
    )
    fireEvent.click(screen.getByTestId("dependency-node-a"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelectTask).toHaveBeenCalledWith("a")
  })

  it("renders nothing graph-wise when closed", () => {
    render(
      <TaskDependencyDialog
        open={false}
        onOpenChange={jest.fn()}
        tasks={tasks}
        onSelectTask={jest.fn()}
      />
    )
    expect(screen.queryByTestId("dependency-node-a")).toBeNull()
  })
})
