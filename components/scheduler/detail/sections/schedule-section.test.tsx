import { render, screen } from "@testing-library/react"

import { ScheduleSection } from "./schedule-section"
import type { ScheduledTask } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(overrides: Partial<UnifiedScheduledItem> = {}): UnifiedScheduledItem {
  return {
    unifiedId: "app:t1",
    kind: "app",
    sourceId: "t1",
    name: "Nightly",
    status: "active",
    triggerSummary: { type: "cron", cron: "0 2 * * *", timezone: "Asia/Shanghai" },
    nextRunAt: Date.UTC(2026, 8, 14, 2),
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
    ...overrides,
  }
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Nightly",
    type: "chat",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 2 * * *", jitterMs: 30_000 },
    payload: { type: "chat", prompt: "x" },
    config: {
      timeout: 120_000,
      maxRetries: 2,
      maxRuns: 10,
      pauseAfterConsecutiveFailures: 3,
      catchupWindowMs: 600_000,
    },
    notification: { channels: [], onStart: false, onComplete: false, onError: false },
    runCount: 4,
    successCount: 4,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ScheduledTask
}

describe("ScheduleSection", () => {
  it("shows the trigger facts every kind has", () => {
    render(<ScheduleSection item={item({ kind: "workflow" })} />)
    expect(screen.getByText("Schedule (Cron)")).toBeInTheDocument()
    expect(screen.getByText("0 2 * * *")).toBeInTheDocument()
    expect(screen.getByText("Asia/Shanghai")).toBeInTheDocument()
    expect(screen.getByText("Never")).toBeInTheDocument()
    expect(screen.queryByText("Max Retries")).not.toBeInTheDocument()
  })

  it("adds the execution config and limits for an app task", () => {
    render(<ScheduleSection item={item()} task={task()} />)
    expect(screen.getByText("Max Retries")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
    expect(screen.getByText("4/10")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByText("10 min")).toBeInTheDocument()
    expect(screen.getByText("30s")).toBeInTheDocument()
    expect(screen.getByText("Overlap policy")).toBeInTheDocument()
  })
})
