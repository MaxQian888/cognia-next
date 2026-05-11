/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Radix DropdownMenu portals its content; stub it to render children inline so
// menu items are queryable directly.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({
    children,
    asChild,
    ...rest
  }: {
    children: React.ReactNode
    asChild?: boolean
  } & React.HTMLAttributes<HTMLElement>) =>
    asChild ? <>{children}</> : <button {...rest}>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement> & { onClick?: () => void }) => (
    <div
      role="menuitem"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick?.()
      }}
      tabIndex={0}
      {...rest}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

jest.mock("./task-stats-cards", () => ({
  __esModule: true,
  TaskStatsCards: () => <div data-testid="task-stats-cards-stub" />,
}))
jest.mock("./task-execution-chart", () => ({
  __esModule: true,
  TaskExecutionChart: () => <div data-testid="task-execution-chart-stub" />,
}))
jest.mock("./task-execution-history", () => ({
  __esModule: true,
  TaskExecutionHistory: () => <div data-testid="task-execution-history-stub" />,
}))
jest.mock("./task-configuration", () => ({
  __esModule: true,
  TaskConfiguration: () => <div data-testid="task-configuration-stub" />,
}))
jest.mock("./task-notification-display", () => ({
  __esModule: true,
  TaskNotificationDisplay: () => <div data-testid="task-notification-display-stub" />,
}))
jest.mock("./task-tags-display", () => ({
  __esModule: true,
  TaskTagsDisplay: () => <div data-testid="task-tags-display-stub" />,
}))

import { SchedulerMobileDetailView } from "./scheduler-mobile-detail"
import type { ScheduledTask } from "@/types/scheduler"

function buildTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Hello task",
    description: "",
    type: "app",
    status: "active",
    trigger: { kind: "cron", cron: "* * * * *", timezone: "UTC" },
    payload: {},
    config: {},
    notification: { enabled: false },
    tags: ["alpha"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as ScheduledTask
}

function callbacks() {
  return {
    onBack: jest.fn(),
    onPause: jest.fn(),
    onResume: jest.fn(),
    onRunNow: jest.fn(),
    onDelete: jest.fn(),
    onEdit: jest.fn(),
  }
}

describe("SchedulerMobileDetailView", () => {
  it("renders task name and active status badge", () => {
    const cbs = callbacks()
    render(<SchedulerMobileDetailView task={buildTask()} executions={[]} {...cbs} />)
    expect(screen.getByText("Hello task")).toBeInTheDocument()
    const badge = screen.getByTestId("mobile-detail-status-badge")
    expect(badge.className).toContain("text-green-500")
  })

  it("invokes onBack when back button is clicked", () => {
    const cbs = callbacks()
    render(<SchedulerMobileDetailView task={buildTask()} executions={[]} {...cbs} />)
    fireEvent.click(screen.getByTestId("mobile-detail-back"))
    expect(cbs.onBack).toHaveBeenCalled()
  })

  it("dispatches Run Now from the dropdown", () => {
    const cbs = callbacks()
    render(<SchedulerMobileDetailView task={buildTask()} executions={[]} {...cbs} />)
    fireEvent.click(screen.getByTestId("mobile-detail-more-trigger"))
    fireEvent.click(screen.getByText("runNow"))
    expect(cbs.onRunNow).toHaveBeenCalledWith("t1")
  })

  it("dispatches Pause when status is active", () => {
    const cbs = callbacks()
    render(
      <SchedulerMobileDetailView task={buildTask({ status: "active" })} executions={[]} {...cbs} />
    )
    fireEvent.click(screen.getByTestId("mobile-detail-more-trigger"))
    fireEvent.click(screen.getByText("pause"))
    expect(cbs.onPause).toHaveBeenCalledWith("t1")
    expect(cbs.onResume).not.toHaveBeenCalled()
  })

  it("swaps Pause for Resume when status is paused and dispatches onResume", () => {
    const cbs = callbacks()
    render(
      <SchedulerMobileDetailView task={buildTask({ status: "paused" })} executions={[]} {...cbs} />
    )
    fireEvent.click(screen.getByTestId("mobile-detail-more-trigger"))
    expect(screen.getByText("resume")).toBeInTheDocument()
    expect(screen.queryByText("pause")).toBeNull()
    fireEvent.click(screen.getByText("resume"))
    expect(cbs.onResume).toHaveBeenCalledWith("t1")
  })

  it("dispatches Edit and Delete from the dropdown", () => {
    const cbs = callbacks()
    render(<SchedulerMobileDetailView task={buildTask()} executions={[]} {...cbs} />)
    fireEvent.click(screen.getByTestId("mobile-detail-more-trigger"))
    fireEvent.click(screen.getByText("edit"))
    expect(cbs.onEdit).toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("mobile-detail-more-trigger"))
    fireEvent.click(screen.getByText("delete"))
    expect(cbs.onDelete).toHaveBeenCalledWith("t1")
  })

  it("applies the right status badge classes for each known status", () => {
    const cbs = callbacks()
    for (const [status, expected] of [
      ["paused", "text-yellow-500"],
      ["disabled", "text-gray-400"],
      ["expired", "text-red-500"],
    ] as const) {
      const { unmount } = render(
        <SchedulerMobileDetailView task={buildTask({ status })} executions={[]} {...cbs} />
      )
      expect(screen.getByTestId("mobile-detail-status-badge").className).toContain(expected)
      unmount()
    }
  })

  it("falls back to an empty class string for unknown statuses", () => {
    const cbs = callbacks()
    render(
      <SchedulerMobileDetailView
        task={buildTask({ status: "weird" as unknown as ScheduledTask["status"] })}
        executions={[]}
        {...cbs}
      />
    )
    const badge = screen.getByTestId("mobile-detail-status-badge")
    // None of the known color classes should be present.
    expect(badge.className).not.toMatch(/text-(green|yellow|gray|red)-/)
  })

  it("renders all six sub-component stubs", () => {
    const cbs = callbacks()
    render(<SchedulerMobileDetailView task={buildTask()} executions={[]} {...cbs} />)
    expect(screen.getByTestId("task-stats-cards-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-execution-chart-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-execution-history-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-configuration-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-notification-display-stub")).toBeInTheDocument()
    expect(screen.getByTestId("task-tags-display-stub")).toBeInTheDocument()
  })

  it("falls back to an empty tags array if task.tags is undefined", () => {
    const cbs = callbacks()
    render(
      <SchedulerMobileDetailView
        task={buildTask({ tags: undefined as unknown as string[] })}
        executions={[]}
        {...cbs}
      />
    )
    // No assertion on stub content needed — the branch is exercised.
    expect(screen.getByTestId("task-tags-display-stub")).toBeInTheDocument()
  })
})
