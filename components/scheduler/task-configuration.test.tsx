/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/scheduler/cron-parser", () => ({
  describeCronExpression: (expr: string) => `desc:${expr}`,
}))

import { TaskConfiguration } from "./task-configuration"
import type { ScheduledTask } from "@/types/scheduler"

function buildTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Task",
    description: "",
    type: "custom",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 * * * *", timezone: "UTC" },
    payload: {},
    config: { timeout: 30_000, maxRetries: 3, allowConcurrent: false },
    notification: { enabled: false },
    tags: [],
    successCount: 0,
    failureCount: 0,
    ...overrides,
  } as unknown as ScheduledTask
}

describe("TaskConfiguration", () => {
  it("describes a cron expression using the cron parser", () => {
    render(<TaskConfiguration task={buildTask()} />)
    expect(screen.getByText("desc:0 * * * *")).toBeInTheDocument()
  })

  it("renders an em-dash for cron without an expression", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          trigger: { type: "cron" } as unknown as ScheduledTask["trigger"],
        })}
      />
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("renders interval triggers in minutes", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          trigger: { type: "interval", intervalMs: 300_000 } as unknown as ScheduledTask["trigger"],
        })}
      />
    )
    expect(screen.getByText("5 min")).toBeInTheDocument()
  })

  it("renders em-dash for interval without intervalMs", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          trigger: { type: "interval" } as unknown as ScheduledTask["trigger"],
        })}
      />
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("renders once triggers as a localized date string", () => {
    const runAt = new Date("2030-01-15T10:00:00Z")
    render(
      <TaskConfiguration
        task={buildTask({
          trigger: { type: "once", runAt } as unknown as ScheduledTask["trigger"],
        })}
      />
    )
    // Day-month/year content varies by locale — just check there's a number.
    const matches = screen.queryAllByText(/2030/)
    expect(matches.length).toBeGreaterThan(0)
  })

  it("renders em-dash for once without runAt", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          trigger: { type: "once" } as unknown as ScheduledTask["trigger"],
        })}
      />
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("renders eventType for event triggers", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          trigger: {
            type: "event",
            eventType: "user.signup",
          } as unknown as ScheduledTask["trigger"],
        })}
      />
    )
    expect(screen.getByText("user.signup")).toBeInTheDocument()
  })

  it("falls back to em-dash for unknown trigger types", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          trigger: { type: "weird-type" as never } as unknown as ScheduledTask["trigger"],
        })}
      />
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("formats timeout in seconds and shows allowConcurrent state", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          config: { timeout: 45_000, maxRetries: 5, allowConcurrent: true } as never,
        })}
      />
    )
    expect(screen.getByText("45s")).toBeInTheDocument()
    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.getByText("allowed")).toBeInTheDocument()
  })

  it("shows systemDefault when trigger has no timezone", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          trigger: {
            type: "cron",
            cronExpression: "0 * * * *",
          } as unknown as ScheduledTask["trigger"],
        })}
      />
    )
    expect(screen.getByText("systemDefault")).toBeInTheDocument()
  })

  it("forwards className to the wrapping Card", () => {
    const { container } = render(<TaskConfiguration task={buildTask()} className="extra-class" />)
    expect(container.querySelector(".extra-class")).not.toBeNull()
  })
})
