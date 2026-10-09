/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ScheduledTask } from "@/types/scheduler"

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const NOW = new Date("2026-10-07T07:00:00Z")
let mockNow = NOW
const relativeTime = jest.fn((value: Date, now: Date) => `rel(${value.getTime() - now.getTime()})`)
jest.mock("next-intl", () => ({
  useNow: () => mockNow,
  useFormatter: () => ({ relativeTime }),
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

let tasksResult: ScheduledTask[] | undefined = []
let lastQuery: (() => unknown) | undefined
let lastDeps: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => unknown, deps: unknown[]) => {
    lastQuery = fn
    lastDeps = deps
    return tasksResult
  },
}))
const getUpcomingTasks = jest.fn().mockResolvedValue([])
jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getUpcomingTasks: (...args: unknown[]) => getUpcomingTasks(...args) },
}))
let hostTarget: "local" | "paired" = "local"
jest.mock("@/hooks/scheduler/use-scheduler-host-target", () => ({
  useSchedulerHostTarget: () => ({ target: hostTarget }),
}))

import { TooltipProvider } from "@/components/ui/tooltip"
import { OverlaySideContext } from "@/components/shell/rail-overlay-side"
import { StatusBarNextRun } from "./status-bar-next-run"
import { scheduleHref } from "@/components/workspace/workspace-schedules"

function task(over: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t1",
    name: "Daily digest",
    type: "chat",
    status: "active",
    nextRunAt: new Date(NOW.getTime() + 2 * 3_600_000),
    ...over,
  } as ScheduledTask
}

beforeEach(() => {
  mockNow = NOW
  tasksResult = []
  lastQuery = undefined
  lastDeps = []
  hostTarget = "local"
  jest.clearAllMocks()
})

describe("StatusBarNextRun", () => {
  it("renders nothing without an upcoming schedule", () => {
    const { container } = render(<StatusBarNextRun />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names the soonest schedule and when it fires, linking to it", () => {
    const next = task({})
    tasksResult = [next]
    render(<StatusBarNextRun />)
    const link = screen.getByTestId("status-next-run")
    expect(link).toHaveTextContent("Daily digest")
    expect(link).toHaveTextContent(`rel(${2 * 3_600_000})`)
    expect(link).toHaveAttribute("href", scheduleHref(next))
    expect(link).toHaveAttribute(
      "aria-label",
      `label:${JSON.stringify({ name: "Daily digest", when: `rel(${2 * 3_600_000})` })}`
    )
    // Drops itself on a narrow window.
    expect(link.className).toContain("hidden")
    expect(link.className).toContain("lg:flex")
  })

  it("asks the local scheduler for exactly one upcoming task", async () => {
    render(<StatusBarNextRun />)
    await lastQuery?.()
    expect(getUpcomingTasks).toHaveBeenCalledWith(1)
  })

  it("re-queries every minute, since 'upcoming' is relative to now", () => {
    const { rerender } = render(<StatusBarNextRun />)
    const first = lastDeps
    mockNow = new Date(NOW.getTime() + 61_000)
    rerender(<StatusBarNextRun />)
    expect(lastDeps[1]).not.toBe(first[1])
  })

  it("steps aside while this window drives a paired host's scheduler", async () => {
    hostTarget = "paired"
    tasksResult = [task({})]
    const { container } = render(<StatusBarNextRun />)
    expect(container).toBeEmptyDOMElement()
    await expect(lastQuery?.()).resolves.toEqual([])
    expect(getUpcomingTasks).not.toHaveBeenCalled()
  })

  describe("rail variant", () => {
    const label = (ms: number) =>
      `label:${JSON.stringify({ name: "Daily digest", when: `rel(${ms})` })}`

    function renderRail(side: "left" | "right" = "right") {
      return render(
        <TooltipProvider>
          <OverlaySideContext.Provider value={side}>
            <StatusBarNextRun variant="rail" />
          </OverlaySideContext.Provider>
        </TooltipProvider>
      )
    }

    it("renders the glyph alone: no name or relative time printed into the rail", () => {
      const next = task({})
      tasksResult = [next]
      renderRail()
      const link = screen.getByTestId("status-next-run")
      expect(link).toHaveAttribute("data-variant", "rail")
      expect(link.textContent).toBe("")
      expect(link.querySelector("svg")).not.toBeNull()
      expect(link).toHaveAttribute("href", scheduleHref(next))
      // Fixed rail-sized target, and visible at every width (the rail is).
      expect(link.className).toContain("size-9")
      expect(link.className).not.toContain("hidden")
    })

    it("names the schedule and its time in the accessible name and the tooltip", async () => {
      tasksResult = [task({})]
      renderRail()
      const link = screen.getByRole("link", { name: label(2 * 3_600_000) })
      expect(link).not.toHaveAttribute("title")
      await userEvent.hover(link)
      expect(await screen.findByRole("tooltip")).toHaveTextContent(label(2 * 3_600_000))
    })

    it("marks a schedule due within the hour, and only then", () => {
      tasksResult = [task({ nextRunAt: new Date(NOW.getTime() + 5 * 60_000) })]
      const { unmount } = renderRail()
      expect(screen.getByTestId("status-next-run-imminent")).toHaveAttribute("aria-hidden", "true")
      unmount()
      tasksResult = [task({})]
      renderRail()
      expect(screen.queryByTestId("status-next-run-imminent")).toBeNull()
    })

    it("still steps aside for a paired host's scheduler", () => {
      hostTarget = "paired"
      tasksResult = [task({})]
      renderRail()
      expect(screen.queryByTestId("status-next-run")).toBeNull()
    })
  })
})
