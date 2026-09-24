/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import { FunctionalToastCard } from "./card"
import { SCHEDULED_DUE_META_KEY, buildScheduledDueMeta } from "./scheduled-due"
import type { NotificationRecord } from "@/types/notifications"
import type { ScheduledTask } from "@/types/scheduler"

const NOW = Date.now()
const H = 60 * 60 * 1000

function makeTask(): ScheduledTask {
  return {
    id: "t1",
    name: "Provider diagnostics refresh",
    type: "provider-diagnostics-refresh",
    trigger: { type: "interval", intervalMs: 4 * H },
    config: { timeout: 60_000, maxRetries: 0, retryDelay: 0, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: true, onError: true },
    status: "active",
    lastRunAt: new Date(NOW - 4 * H),
    nextRunAt: new Date(NOW + 4 * H),
    runCount: 128,
    successCount: 127,
    failureCount: 1,
    consecutiveFailures: 0,
    lastTerminalReason: "completed",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

function makeRecord(meta: Record<string, unknown> | undefined): NotificationRecord {
  return {
    id: "n1",
    source: "system",
    level: "info",
    title: "Scheduled task due",
    body: '"Provider diagnostics refresh" is due right now.',
    createdAt: NOW,
    updatedAt: NOW,
    readState: "unseen",
    count: 1,
    directed: true,
    deliveredVia: ["toast"],
    groupKey: "pet-scheduled-due",
    sourceRef: { kind: "task", id: "t1" },
    href: "/scheduler?item=app%3At1",
    actions: [
      {
        id: "open",
        label: "Open",
        command: "scheduler.open-task",
        args: { taskId: "t1" },
        variant: "primary",
      },
      { id: "mute", label: "Mute", command: "scheduled-due.mute", args: { taskId: "t1" } },
    ],
    ...(meta ? { meta } : {}),
  }
}

describe("FunctionalToastCard", () => {
  it("renders the Agenda+ card from record meta — localized, with the task's actions", () => {
    const meta = { [SCHEDULED_DUE_META_KEY]: buildScheduledDueMeta(makeTask()) }
    render(
      <FunctionalToastCard rec={makeRecord(meta)} onAction={jest.fn()} onDismiss={jest.fn()} />
    )

    // Real English strings resolved through the functionalToast namespace.
    expect(screen.getByText("Due now")).toBeInTheDocument()
    expect(screen.getByText("Provider diagnostics refresh")).toBeInTheDocument()
    expect(screen.getByText("Every 4h")).toBeInTheDocument()
    expect(screen.getByTestId("due-timeline")).toBeInTheDocument()
    expect(screen.getByText("Run #129 starting")).toBeInTheDocument()
    // Persisted actions render with their localized labels.
    expect(screen.getByTestId("functional-toast-action-open")).toHaveTextContent("Open")
    expect(screen.getByTestId("functional-toast-action-mute")).toHaveTextContent("Mute")
  })

  it("routes a clicked action's persisted NotificationAction to onAction", () => {
    const meta = { [SCHEDULED_DUE_META_KEY]: buildScheduledDueMeta(makeTask()) }
    const onAction = jest.fn()
    render(<FunctionalToastCard rec={makeRecord(meta)} onAction={onAction} onDismiss={jest.fn()} />)
    fireEvent.click(screen.getByTestId("functional-toast-action-mute"))
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "mute",
        notificationAction: expect.objectContaining({ command: "scheduled-due.mute" }),
      })
    )
  })

  it("falls back to a plain title/body card when the meta is missing", () => {
    render(
      <FunctionalToastCard rec={makeRecord(undefined)} onAction={jest.fn()} onDismiss={jest.fn()} />
    )
    expect(screen.getByText("Scheduled task due")).toBeInTheDocument()
    expect(screen.getByText('"Provider diagnostics refresh" is due right now.')).toBeInTheDocument()
    // Same chrome — the dismiss control is still there.
    expect(screen.getByLabelText("Dismiss")).toBeInTheDocument()
    // But no due-only furniture.
    expect(screen.queryByTestId("due-timeline")).not.toBeInTheDocument()
  })
})
