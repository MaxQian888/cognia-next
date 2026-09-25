/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ScheduledTask } from "@/types/scheduler"

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

let tasksResult: ScheduledTask[] | undefined = []
let lastDeps: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (_fn: () => unknown, deps: unknown[]) => {
    lastDeps = deps
    return tasksResult
  },
}))
jest.mock("@/lib/scheduler/scheduler-db", () => ({ schedulerDb: { getTasksByProject: jest.fn() } }))
let hostTarget: "local" | "paired" = "local"
jest.mock("@/hooks/scheduler/use-scheduler-host-target", () => ({
  useSchedulerHostTarget: () => ({ target: hostTarget }),
}))

import {
  orderSchedules,
  scheduleHref,
  WORKSPACE_SCHEDULE_LIMIT,
  WorkspaceSchedules,
} from "./workspace-schedules"

const NOW = Date.parse("2026-09-25T12:00:00Z")

function task(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t",
    name: "Task",
    type: "chat",
    status: "active",
    projectId: "w1",
    ...over,
  } as ScheduledTask
}

beforeEach(() => {
  tasksResult = []
  lastDeps = []
  hostTarget = "local"
})

describe("orderSchedules", () => {
  it("puts running schedules first, soonest first, then the rest by name", () => {
    const ordered = orderSchedules([
      task({ id: "paused", name: "B", status: "paused" }),
      task({ id: "later", nextRunAt: new Date(NOW + 60_000) }),
      task({ id: "sooner", nextRunAt: new Date(NOW + 1_000) }),
      task({ id: "expired", name: "A", status: "expired" }),
      task({ id: "never", name: "Z" }),
    ])
    expect(ordered.map((t) => t.id)).toEqual(["sooner", "later", "never", "paused", "expired"])
  })
})

describe("scheduleHref", () => {
  it("addresses the row under the kind the scheduler lists it as", () => {
    expect(scheduleHref({ id: "t1", type: "chat" } as ScheduledTask)).toBe(
      "/scheduler?item=app%3At1"
    )
    expect(scheduleHref({ id: "t2", type: "plugin" } as ScheduledTask)).toBe(
      "/scheduler?item=plugin%3At2"
    )
  })
})

describe("WorkspaceSchedules", () => {
  it("waits for the read instead of saying nothing is scheduled", () => {
    tasksResult = undefined
    render(<WorkspaceSchedules workspaceId="w1" />)
    expect(screen.getByTestId("workspace-schedules-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-schedules-empty")).not.toBeInTheDocument()
  })

  it("says so, and where to add one, when nothing is scheduled", () => {
    render(<WorkspaceSchedules workspaceId="w1" />)
    expect(screen.getByTestId("workspace-schedules-empty")).toHaveTextContent(
      "Nothing is scheduled in this workspace."
    )
    expect(screen.getByRole("link", { name: "Open scheduler" })).toHaveAttribute(
      "href",
      "/scheduler"
    )
  })

  it("lists the next few, marks the shared ones, and counts what is running", () => {
    tasksResult = [
      task({ id: "a", name: "Nightly digest", nextRunAt: new Date(NOW + 60_000) }),
      task({ id: "b", name: "Shared sweep", projectId: undefined }),
      task({ id: "c", name: "Paused job", status: "paused" }),
      ...Array.from({ length: WORKSPACE_SCHEDULE_LIMIT }, (_, i) =>
        task({ id: `x${i}`, name: `Extra ${i}`, status: "disabled" })
      ),
    ]
    render(<WorkspaceSchedules workspaceId="w1" />)

    const list = screen.getByTestId("workspace-schedules-list")
    expect(list.querySelectorAll("li")).toHaveLength(WORKSPACE_SCHEDULE_LIMIT)
    expect(screen.getByTestId("workspace-schedule-a")).toHaveAttribute(
      "href",
      "/scheduler?item=app%3Aa"
    )
    expect(screen.getByTestId("workspace-schedule-b")).toHaveTextContent("All workspaces")
    expect(screen.getByTestId("workspace-schedule-a")).not.toHaveTextContent("All workspaces")
    expect(screen.getByTestId("workspace-schedule-c")).toHaveTextContent("Paused")
    expect(screen.getByTestId("workspace-section-schedules")).toHaveTextContent(
      `2/${WORKSPACE_SCHEDULE_LIMIT + 3} active`
    )
  })

  /**
   * Workspace ids are local, so this device's table says nothing about what a
   * paired host runs. An empty list there would read as "nothing scheduled".
   */
  it("points at the scheduler instead of listing a paired host's schedules", () => {
    hostTarget = "paired"
    tasksResult = [task({ id: "a" })]
    render(<WorkspaceSchedules workspaceId="w1" />)
    expect(screen.getByTestId("workspace-schedules-remote")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-schedules-list")).not.toBeInTheDocument()
    expect(lastDeps).toEqual(["w1", false])
  })
})
