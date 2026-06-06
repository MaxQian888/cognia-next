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

  it("formats timeout in seconds and derives the overlap policy from legacy allowConcurrent", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          config: { timeout: 45_000, maxRetries: 5, allowConcurrent: true } as never,
        })}
      />
    )
    expect(screen.getByText("45s")).toBeInTheDocument()
    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.getByText("overlapPolicies.allow.title")).toBeInTheDocument()
  })

  it("shows an explicit overlap policy over the legacy boolean", () => {
    render(
      <TaskConfiguration
        task={buildTask({
          config: {
            timeout: 30_000,
            maxRetries: 1,
            allowConcurrent: true,
            overlapPolicy: "queue-all",
          } as never,
        })}
      />
    )
    expect(screen.getByText("overlapPolicies.queueAll.title")).toBeInTheDocument()
  })

  it("renders optional lifecycle / policy rows only when configured", () => {
    const { rerender } = render(<TaskConfiguration task={buildTask()} />)
    expect(screen.queryByText("lifecycle.maxRuns")).not.toBeInTheDocument()
    expect(screen.queryByText("pauseAfterFailures.label")).not.toBeInTheDocument()
    expect(screen.queryByText("catchupWindow.label")).not.toBeInTheDocument()
    expect(screen.queryByText("jitter.label")).not.toBeInTheDocument()
    expect(screen.queryByText("lifecycle.endDate")).not.toBeInTheDocument()

    rerender(
      <TaskConfiguration
        task={buildTask({
          endAt: new Date("2026-12-31T00:00:00Z"),
          runCount: 3,
          trigger: { type: "interval", intervalMs: 60_000, jitterMs: 5_000 } as never,
          config: {
            timeout: 30_000,
            maxRetries: 1,
            overlapPolicy: "skip",
            maxRuns: 10,
            pauseAfterConsecutiveFailures: 4,
            catchupWindowMs: 120_000,
          } as never,
        })}
      />
    )
    expect(screen.getByText("lifecycle.endDate")).toBeInTheDocument()
    expect(screen.getByText("3/10")).toBeInTheDocument()
    expect(screen.getByText("4")).toBeInTheDocument()
    expect(screen.getByText("2 min")).toBeInTheDocument()
    expect(screen.getByText("5s")).toBeInTheDocument()
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
