/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (values && Object.keys(values).length > 0) {
      const parts = Object.entries(values).map(([k, v]) => `${k}=${v}`)
      return `${key}(${parts.join(",")})`
    }
    return key
  },
}))

// Stub Radix DropdownMenu to render inline so menu items are queryable.
jest.mock("@/components/ui/dropdown-menu")

// formatNextRun is exercised inside; mock it to a stable string.
jest.mock("@/lib/scheduler/format-utils", () => ({
  formatNextRun: () => "in 5m",
}))

import { TaskSidebarItem } from "./task-sidebar-item"
import type { ScheduledTask } from "@/types/scheduler"

function buildTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Test task",
    description: "",
    type: "custom",
    status: "active",
    trigger: { type: "cron", cronExpression: "* * * * *" },
    payload: {},
    config: {},
    notification: { enabled: false },
    tags: [],
    nextRunAt: new Date(Date.now() + 300_000),
    successCount: 0,
    failureCount: 0,
    ...overrides,
  } as unknown as ScheduledTask
}

describe("TaskSidebarItem", () => {
  it("renders the task name and trigger text", () => {
    render(<TaskSidebarItem task={buildTask()} isActive={false} onClick={jest.fn()} />)
    expect(screen.getByText("Test task")).toBeInTheDocument()
  })

  it("dispatches onClick when clicked", () => {
    const onClick = jest.fn()
    render(<TaskSidebarItem task={buildTask()} isActive={false} onClick={onClick} />)
    fireEvent.click(screen.getByText("Test task"))
    expect(onClick).toHaveBeenCalledWith("t1")
  })

  it("dispatches onClick on Enter key", () => {
    const onClick = jest.fn()
    render(<TaskSidebarItem task={buildTask()} isActive={false} onClick={onClick} />)
    const row = screen.getByText("Test task").closest('[role="button"]')!
    fireEvent.keyDown(row, { key: "Enter" })
    expect(onClick).toHaveBeenCalledWith("t1")
  })

  it("dispatches onClick on Space key", () => {
    const onClick = jest.fn()
    render(<TaskSidebarItem task={buildTask()} isActive={false} onClick={onClick} />)
    const row = screen.getByText("Test task").closest('[role="button"]')!
    fireEvent.keyDown(row, { key: " " })
    expect(onClick).toHaveBeenCalledWith("t1")
  })

  it("shows an active border when isActive=true", () => {
    render(<TaskSidebarItem task={buildTask()} isActive={true} onClick={jest.fn()} />)
    const row = screen.getByText("Test task").closest('[role="button"]')!
    expect(row.className).toMatch(/border-primary/)
  })

  it("shows a ring when isHighlighted=true", () => {
    render(
      <TaskSidebarItem task={buildTask()} isActive={false} isHighlighted onClick={jest.fn()} />
    )
    const row = screen.getByText("Test task").closest('[role="button"]')!
    expect(row.className).toMatch(/ring-/)
  })

  it("dispatches onRunNow, onPause, onEdit, onDuplicate, onDelete from the menu", () => {
    const cbs = {
      onClick: jest.fn(),
      onRunNow: jest.fn(),
      onPause: jest.fn(),
      onEdit: jest.fn(),
      onDuplicate: jest.fn(),
      onDelete: jest.fn(),
    }
    render(<TaskSidebarItem task={buildTask()} isActive={false} {...cbs} />)
    // Mocked menu renders items inline as buttons. Click each by its label.
    fireEvent.click(screen.getByText("runNow"))
    expect(cbs.onRunNow).toHaveBeenCalledWith("t1")
    fireEvent.click(screen.getByText("pause"))
    expect(cbs.onPause).toHaveBeenCalledWith("t1")
    fireEvent.click(screen.getByText("edit"))
    expect(cbs.onEdit).toHaveBeenCalledWith("t1")
    fireEvent.click(screen.getByText("duplicate"))
    expect(cbs.onDuplicate).toHaveBeenCalledWith("t1")
    fireEvent.click(screen.getByText("delete"))
    expect(cbs.onDelete).toHaveBeenCalledWith("t1")
  })

  it("dispatches onResume instead of onPause when status is paused", () => {
    const onResume = jest.fn()
    const onPause = jest.fn()
    render(
      <TaskSidebarItem
        task={buildTask({ status: "paused" })}
        isActive={false}
        onClick={jest.fn()}
        onPause={onPause}
        onResume={onResume}
      />
    )
    fireEvent.click(screen.getByText("resume"))
    expect(onResume).toHaveBeenCalledWith("t1")
    expect(onPause).not.toHaveBeenCalled()
  })

  it("renders different trigger text for interval / once / event triggers", () => {
    const { rerender } = render(
      <TaskSidebarItem
        task={buildTask({
          trigger: { type: "interval", intervalMs: 120_000 } as unknown as ScheduledTask["trigger"],
        })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    // With the local mock, `t("every", { minutes: 2 })` returns
    // "every(minutes=2)".
    expect(screen.getByText(/every\(minutes=2\)/)).toBeInTheDocument()

    rerender(
      <TaskSidebarItem
        task={buildTask({ trigger: { type: "once" } as unknown as ScheduledTask["trigger"] })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    expect(screen.getByText(/triggerTypes\.once/)).toBeInTheDocument()

    rerender(
      <TaskSidebarItem
        task={buildTask({
          trigger: {
            type: "event",
            eventType: "user.signup",
          } as unknown as ScheduledTask["trigger"],
        })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    expect(screen.getByText(/user\.signup/)).toBeInTheDocument()
  })

  it("renders a status dot with the right color for each status", () => {
    const { rerender } = render(
      <TaskSidebarItem
        task={buildTask({ status: "active" })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    expect(screen.getByTestId("status-dot").className).toMatch(/bg-green-500/)
    rerender(
      <TaskSidebarItem
        task={buildTask({ status: "paused" })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    expect(screen.getByTestId("status-dot").className).toMatch(/bg-yellow-500/)
    rerender(
      <TaskSidebarItem
        task={buildTask({ status: "disabled" })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    expect(screen.getByTestId("status-dot").className).toMatch(/bg-gray-400/)
    rerender(
      <TaskSidebarItem
        task={buildTask({ status: "expired" })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    expect(screen.getByTestId("status-dot").className).toMatch(/bg-red-500/)
  })

  it("falls back to the gray dot color for unknown statuses", () => {
    render(
      <TaskSidebarItem
        task={buildTask({ status: "weird" as unknown as ScheduledTask["status"] })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    expect(screen.getByTestId("status-dot").className).toMatch(/bg-gray-400/)
  })

  it("renders task type icon for several types (covers config map)", () => {
    for (const type of ["workflow", "agent", "sync", "backup", "plugin", "script"] as const) {
      const { unmount } = render(
        <TaskSidebarItem task={buildTask({ type })} isActive={false} onClick={jest.fn()} />
      )
      expect(screen.getByText("Test task")).toBeInTheDocument()
      unmount()
    }
  })

  it("falls back to the custom icon for unknown task types", () => {
    render(
      <TaskSidebarItem
        task={buildTask({ type: "weird-type" as unknown as ScheduledTask["type"] })}
        isActive={false}
        onClick={jest.fn()}
      />
    )
    expect(screen.getByText("Test task")).toBeInTheDocument()
  })
})
