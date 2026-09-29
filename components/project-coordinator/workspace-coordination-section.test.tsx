/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Project } from "@/types"

// next-intl is globally mocked against en.json in jest.setup.ts.

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/lib/project-coordinator/user-actions", () => ({
  enableProjectCoordination: jest.fn(async () => ({ id: "coord" })),
  disableProjectCoordination: jest.fn(),
}))

const settingsState: { settings: Record<string, unknown>; save: jest.Mock } = {
  settings: {},
  save: jest.fn(async () => undefined),
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}))

import { useProjectStore } from "@/stores/project/project-store"
import {
  disableProjectCoordination,
  enableProjectCoordination,
} from "@/lib/project-coordinator/user-actions"
import { WorkspaceCoordinationSection } from "./workspace-coordination-section"

function project(coordinator?: Project["coordinator"]): Project {
  const now = new Date()
  return {
    id: "p1",
    name: "Billing",
    roots: [],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    ...(coordinator ? { coordinator } : {}),
  }
}

function mount(coordinator?: Project["coordinator"]) {
  useProjectStore.setState({ projects: [project(coordinator)] })
  const current = () => useProjectStore.getState().projects[0]
  const view = render(<WorkspaceCoordinationSection project={current()} />)
  return { current, ...view }
}

beforeEach(() => {
  jest.clearAllMocks()
  settingsState.settings = {}
})

describe("WorkspaceCoordinationSection", () => {
  it("turns coordination on", async () => {
    mount()
    expect(screen.queryByTestId("workspace-coordination-fields")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-coordination-enabled"))
    await waitFor(() =>
      expect(enableProjectCoordination).toHaveBeenCalledWith("p1", "Project coordinator")
    )
  })

  it("turns coordination off from an enabled workspace", () => {
    mount({ enabled: true })
    fireEvent.click(screen.getByTestId("workspace-coordination-enabled"))
    expect(disableProjectCoordination).toHaveBeenCalledWith("p1")
  })

  it("saves the goal on blur and holds one that carries a secret", () => {
    const { current } = mount({ enabled: true })
    const goal = screen.getByTestId("project-goal")
    fireEvent.change(goal, { target: { value: "Ship billing v2" } })
    fireEvent.blur(goal)
    expect(current().coordinator?.goal).toBe("Ship billing v2")

    fireEvent.change(goal, { target: { value: "mail ops@example.com" } })
    expect(screen.getByTestId("project-goal-leak")).toBeInTheDocument()
    fireEvent.blur(goal)
    expect(current().coordinator?.goal).toBe("Ship billing v2")
  })

  it("writes the limits and toggles to the workspace row", () => {
    const { current } = mount({ enabled: true })
    const daily = screen.getByTestId("project-daily-cap")
    fireEvent.change(daily, { target: { value: "5" } })
    fireEvent.blur(daily)
    const concurrent = screen.getByTestId("project-max-concurrent")
    fireEvent.change(concurrent, { target: { value: "99" } })
    fireEvent.blur(concurrent)
    fireEvent.click(screen.getByTestId("project-auto-fix-pr"))
    fireEvent.click(screen.getByTestId("project-propose-first"))
    expect(current().coordinator?.preferences).toEqual({
      dailyThreadCap: 5,
      maxConcurrentThreads: 16,
      autoFixPr: true,
      proposeBeforeStart: true,
    })
    const icon = screen.getByTestId("project-icon")
    fireEvent.change(icon, { target: { value: "🚀" } })
    fireEvent.blur(icon)
    expect(current().coordinator?.icon).toBe("🚀")
  })

  it("chooses where threads run", async () => {
    const user = userEvent.setup()
    const { current } = mount({ enabled: true })
    await user.click(screen.getByTestId("project-thread-execution"))
    await user.click(await screen.findByRole("option", { name: "Always the workspace folder" }))
    expect(current().coordinator?.threadExecution).toBe("local")
  })

  it("writes the workspace's ceiling into the cost-budget policy", () => {
    settingsState.settings = { costBudget: { dailyUsd: 50, perProjectDailyUsd: { other: 3 } } }
    mount()
    const daily = screen.getByTestId("project-budget-daily")
    fireEvent.change(daily, { target: { value: "12.5" } })
    fireEvent.blur(daily)
    expect(settingsState.save).toHaveBeenCalledWith({
      costBudget: { dailyUsd: 50, perProjectDailyUsd: { other: 3, p1: 12.5 } },
    })
  })

  it("clears the workspace's ceiling and drops an emptied map", () => {
    settingsState.settings = { costBudget: { perProjectMonthlyUsd: { p1: 40 } } }
    mount()
    const monthly = screen.getByTestId("project-budget-monthly")
    fireEvent.change(monthly, { target: { value: "" } })
    fireEvent.blur(monthly)
    expect(settingsState.save).toHaveBeenCalledWith({
      costBudget: { perProjectMonthlyUsd: undefined },
    })
  })

  it("mutes the workspace's notifications, and drops the rule when unmuted", () => {
    mount()
    fireEvent.click(screen.getByTestId("project-notifications-on"))
    const muted = settingsState.save.mock.calls[0][0].notificationPreferences
    expect(muted.perProject).toEqual({ p1: { enabled: false } })

    settingsState.settings = { notificationPreferences: { perProject: { p1: { enabled: false } } } }
    settingsState.save.mockClear()
    mount()
    fireEvent.click(screen.getAllByTestId("project-notifications-on").at(-1)!)
    expect(settingsState.save.mock.calls[0][0].notificationPreferences.perProject).toBeUndefined()
  })

  it("raises the workspace's system-notification gate", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByTestId("project-notifications-os-gate"))
    await user.click(await screen.findByRole("option", { name: "Errors and above" }))
    expect(settingsState.save.mock.calls[0][0].notificationPreferences.perProject).toEqual({
      p1: { enabled: true, minOsLevel: "error" },
    })
  })

  it("links to this workspace's memory", () => {
    mount()
    expect(screen.getByTestId("workspace-coordination-memory")).toHaveAttribute(
      "href",
      "/memory?workspace=p1"
    )
  })
})
