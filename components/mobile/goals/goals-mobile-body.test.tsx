/**
 * @jest-environment jsdom
 */
import { useEffect, useState, type DependencyList } from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

import type { Goal } from "@/types/goal"

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/goals",
  useSearchParams: () => new URLSearchParams(),
}))

// A minimal live query: resolve the querier after mount and again whenever
// its deps change. First paint is `undefined`, as with Dexie's hook.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown, deps: DependencyList = []) => {
    const [value, setValue] = useState<unknown>(undefined)
    useEffect(() => {
      let cancelled = false
      void Promise.resolve(querier()).then((next) => {
        if (!cancelled) setValue(next)
      })
      return () => {
        cancelled = true
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

// The goal store the body reads through `lib/db/goals`. `pending` holds the
// reads back so a test can see the first-paint skeleton.
let mockGoals: Goal[] = []
let mockPending: Promise<void> | null = null
jest.mock("@/lib/db/goals", () => {
  const settle = async () => {
    if (mockPending) await mockPending
  }
  return {
    listOpenGoals: jest.fn(async () => {
      await settle()
      return mockGoals.filter((goal) => goal.status === "active" || goal.status === "paused")
    }),
    listAllGoals: jest.fn(async () => {
      await settle()
      return [...mockGoals]
    }),
    getGoal: jest.fn(async (id: string) => mockGoals.find((goal) => goal.id === id)),
  }
})
// Sessions, agent names and judge verdicts: a Dexie + data-adapter read with
// its own suite. `mockJudgeNotes` stands in for the synced goal event log, and
// the hook only answers from it when the body asked for judge notes.
let mockJudgeNotes = new Map<string, string>()
const mockRowContextOptions: Array<{ judgeNotes?: boolean } | undefined> = []
jest.mock("@/hooks/goal/use-goal-row-context", () => ({
  useGoalRowContext: (_goals: unknown, options?: { judgeNotes?: boolean }) => {
    mockRowContextOptions.push(options)
    return {
      sessionFor: (goal: Pick<Goal, "sessionId">) =>
        goal.sessionId === "ses_gone"
          ? null
          : ({ id: goal.sessionId, title: `Chat ${goal.sessionId}` } as ChatSession),
      agentNameFor: () => undefined,
      judgeNoteFor: (goal: Pick<Goal, "id">) =>
        options?.judgeNotes ? (mockJudgeNotes.get(goal.id) ?? null) : null,
    }
  },
}))
jest.mock("@/lib/goal/acceptance", () => ({
  resolveGoalAcceptance: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/sync/companion-sync", () => ({ runSyncDown: jest.fn().mockResolvedValue([]) }))
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({
    children,
    onRefresh,
  }: {
    children: React.ReactNode
    onRefresh: () => void
  }) => (
    <div>
      <button data-testid="ptr-refresh" onClick={() => onRefresh()} />
      {children}
    </div>
  ),
}))
// The drawer (`GoalDetailSheet` → `GoalDetailPanel`) has its own suites.
jest.mock("@/components/goal/goal-detail-sheet", () => ({
  GoalDetailSheet: ({
    goal,
    open,
    onOpenChange,
    onDeleted,
  }: {
    goal: Goal
    open: boolean
    onOpenChange: (open: boolean) => void
    onDeleted?: () => void
  }) =>
    open ? (
      <div data-testid="goal-detail-sheet" data-goal-id={goal.id}>
        <button data-testid="goal-detail-sheet-close" onClick={() => onOpenChange(false)} />
        <button data-testid="goal-detail-sheet-deleted" onClick={() => onDeleted?.()} />
      </div>
    ) : null,
}))
jest.mock("@/components/goal/analytics/goal-analytics-panel", () => ({
  GoalAnalyticsPanel: ({ goals }: { goals: Goal[] }) => (
    <div data-testid="mock-analytics-panel" data-count={goals.length} />
  ),
}))

// The verdict's transport follows the platform (`useGoalControls`); the
// paired-phone case flips it.
const mockShell = { platform: "web" }
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockShell.platform }))
jest.mock("@/hooks/data/use-can-control", () => ({ useCanControl: () => true }))
const mockCall = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => mockCall(...args) },
}))

import { resolveGoalAcceptance } from "@/lib/goal/acceptance"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { GoalsMobileBody } from "./goals-mobile-body"

const syncDown = runSyncDown as jest.Mock

function goal(over: Partial<Goal>): Goal {
  return {
    id: "g1",
    sessionId: `ses_${over.id ?? "g1"}`,
    safeObjective: "ship the thing",
    status: "active",
    turnsUsed: 2,
    tokensUsed: 0,
    config: { maxTurns: 10 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  } as unknown as Goal
}

/** Render and wait for the first reads to land. */
async function renderBody() {
  const utils = render(<GoalsMobileBody />)
  await waitFor(() => expect(screen.queryByTestId("mobile-goals-loading")).not.toBeInTheDocument())
  return utils
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGoals = []
  mockPending = null
  mockJudgeNotes = new Map()
  mockRowContextOptions.length = 0
})

describe("<GoalsMobileBody />", () => {
  it("shows skeletons, not the empty state, until the first read lands", async () => {
    let release: () => void = () => {}
    mockPending = new Promise<void>((resolve) => {
      release = resolve
    })
    render(<GoalsMobileBody />)
    expect(screen.getByTestId("mobile-goals-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-goals-stats")).not.toBeInTheDocument()
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument()
    release()
    expect(await screen.findByTestId("empty-state")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goals-stats")).toBeInTheDocument()
  })

  it("counts active, paused (awaiting included) and completed of finished", async () => {
    mockGoals = [
      goal({ id: "a1", status: "active" }),
      goal({ id: "a2", status: "active" }),
      goal({ id: "p1", status: "paused" }),
      goal({ id: "w1", status: "paused", awaitingAcceptance: true }),
      goal({ id: "c1", status: "completed" }),
      goal({ id: "s1", status: "stopped" }),
    ]
    await renderBody()
    expect(screen.getByTestId("mobile-goal-stat-active")).toHaveTextContent("2")
    expect(screen.getByTestId("mobile-goal-stat-paused")).toHaveTextContent("2")
    const done = screen.getByTestId("mobile-goal-stat-done")
    expect(done).toHaveTextContent("1")
    expect(done).toHaveTextContent("/2")
  })

  it("renders two-line rows naming the conversation and the turn budget", async () => {
    mockGoals = [goal({ id: "g1", safeObjective: "ship the thing" })]
    await renderBody()
    const row = screen.getByTestId("mobile-goal-g1")
    expect(row).toHaveTextContent("ship the thing")
    expect(row).toHaveTextContent("Chat ses_g1")
    expect(row).toHaveTextContent("2/10 turns")
    expect(within(row).getByTestId("goal-status-chip")).toHaveTextContent("active")
  })

  it("says so when a goal's conversation is gone", async () => {
    mockGoals = [goal({ id: "g1", sessionId: "ses_gone" })]
    await renderBody()
    expect(screen.getByTestId("mobile-goal-g1")).toHaveTextContent(
      "Conversation deleted"
    )
  })

  it("fills the width and keeps the title off the shell's banner", async () => {
    await renderBody()
    const main = screen.getByTestId("mobile-goals-body")
    expect(main).toHaveClass("w-full", "min-w-0", "pb-6", "safe-area-pt")
    expect(main).not.toHaveClass("pt-3")
    expect(main.querySelector("header")).toHaveClass("pt-3")
  })

  it("joins the goal rows into one surface instead of a frame each", async () => {
    mockGoals = [
      goal({ id: "g1", safeObjective: "ship the thing" }),
      goal({ id: "g2", safeObjective: "write the docs" }),
    ]
    const { container } = await renderBody()
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    const list = screen.getByTestId("mobile-goal-g1").closest("ul")
    expect(list).toContainElement(screen.getByTestId("mobile-goal-g2"))
    expect(screen.getByTestId("mobile-goal-g1").closest("li")?.className).toMatch(
      /not-last:border-b/
    )
  })

  it("gives the screen a way back to the hub that opened it", async () => {
    await renderBody()
    expect(screen.getByTestId("mobile-back-button")).toBeInTheDocument()
  })

  it("shows the empty state and leads to chat, where /goal starts one", async () => {
    const user = userEvent.setup()
    await renderBody()
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-spot-icon-goals")).toBeInTheDocument()
    await user.click(screen.getByTestId("mobile-goals-open-chat"))
    expect(mockPush).toHaveBeenCalledWith("/")
  })

  it("lists only open goals on Overview, without a Needs you section", async () => {
    mockGoals = [
      goal({ id: "g1", status: "active", safeObjective: "open one" }),
      goal({ id: "g2", status: "completed", safeObjective: "done one" }),
    ]
    await renderBody()
    expect(screen.getByTestId("mobile-goals-switcher")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-goal-g1")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-goal-g2")).not.toBeInTheDocument()
    expect(screen.queryByTestId("mobile-goals-needs-you")).not.toBeInTheDocument()
    expect(screen.queryByText("Open goals")).not.toBeInTheDocument()
  })

  it("puts goals awaiting a verdict under Needs you with Accept / Request changes", async () => {
    const user = userEvent.setup()
    mockGoals = [
      goal({ id: "run", status: "active", safeObjective: "still running" }),
      goal({ id: "wait", status: "paused", awaitingAcceptance: true, safeObjective: "judged done" }),
    ]
    await renderBody()
    const needsYou = screen.getByTestId("mobile-goals-needs-you")
    expect(within(needsYou).getByRole("heading")).toHaveTextContent("Needs you1")
    expect(within(needsYou).getByTestId("mobile-goal-wait")).toBeInTheDocument()
    expect(within(needsYou).queryByTestId("mobile-goal-run")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Open goals" })).toBeInTheDocument()

    await user.click(within(needsYou).getByTestId("goal-acceptance-accept"))
    await waitFor(() =>
      expect(resolveGoalAcceptance as jest.Mock).toHaveBeenCalledWith("wait", true)
    )
    // Answering does not open the drawer.
    expect(screen.queryByTestId("goal-detail-sheet")).not.toBeInTheDocument()
  })

  it("on a paired phone, Needs you sends the verdict to the desktop over goal_accept", async () => {
    const user = userEvent.setup()
    mockShell.platform = "mobile"
    mockCall.mockReset().mockResolvedValue({ goal: null })
    try {
      mockGoals = [goal({ id: "wait", status: "paused", awaitingAcceptance: true })]
      await renderBody()
      const needsYou = screen.getByTestId("mobile-goals-needs-you")
      await user.click(within(needsYou).getByTestId("goal-acceptance-request-changes"))
      await waitFor(() =>
        expect(mockCall).toHaveBeenCalledWith("goal_accept", { goalId: "wait", accepted: false })
      )
      expect(resolveGoalAcceptance as jest.Mock).not.toHaveBeenCalled()
    } finally {
      mockShell.platform = "web"
    }
  })

  it("lists only Needs you when every open goal awaits a verdict", async () => {
    mockGoals = [goal({ id: "wait", status: "paused", awaitingAcceptance: true })]
    await renderBody()
    expect(screen.getByTestId("mobile-goals-needs-you")).toBeInTheDocument()
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Open goals" })).not.toBeInTheDocument()
  })

  it("opens the goal in the drawer on tap and closes it", async () => {
    const user = userEvent.setup()
    mockGoals = [goal({ id: "g1" })]
    await renderBody()
    await user.click(screen.getByTestId("mobile-goal-g1"))
    const sheet = await screen.findByTestId("goal-detail-sheet")
    expect(sheet).toHaveAttribute("data-goal-id", "g1")
    await user.click(screen.getByTestId("goal-detail-sheet-close"))
    await waitFor(() => expect(screen.queryByTestId("goal-detail-sheet")).not.toBeInTheDocument())
  })

  it("opens a goal via keyboard and drops it once deleted from the drawer", async () => {
    const user = userEvent.setup()
    mockGoals = [goal({ id: "g1" })]
    await renderBody()
    screen.getByTestId("mobile-goal-g1").focus()
    await user.keyboard("{Enter}")
    await screen.findByTestId("goal-detail-sheet")
    await user.click(screen.getByTestId("goal-detail-sheet-deleted"))
    await waitFor(() => expect(screen.queryByTestId("goal-detail-sheet")).not.toBeInTheDocument())
  })

  it("shows the History empty state when there are no goals", async () => {
    const user = userEvent.setup()
    await renderBody()
    await user.click(screen.getByTestId("mobile-goals-section-history"))
    expect(screen.getByTestId("empty-state")).toHaveTextContent(
      "No goals yet. Use the /goal command in a chat to start one."
    )
    expect(screen.queryByTestId("mobile-goals-search")).not.toBeInTheDocument()
  })

  it("lists every goal in History, newest first, and searches it", async () => {
    const user = userEvent.setup()
    mockGoals = [
      goal({ id: "g1", status: "active", safeObjective: "open one", createdAt: 1 }),
      goal({ id: "g2", status: "completed", safeObjective: "done one", createdAt: 2 }),
    ]
    await renderBody()
    await user.click(screen.getByTestId("mobile-goals-section-history"))
    const history = screen.getByTestId("mobile-goals-history")
    const rows = within(history).getAllByRole("button", { name: /one/ })
    expect(rows.map((row) => row.dataset.testid)).toEqual(["mobile-goal-g2", "mobile-goal-g1"])

    await user.type(screen.getByTestId("mobile-goals-search"), "done")
    expect(screen.getByTestId("mobile-goal-g2")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-goal-g1")).not.toBeInTheDocument()

    await user.clear(screen.getByTestId("mobile-goals-search"))
    await user.type(screen.getByTestId("mobile-goals-search"), "zzz")
    expect(screen.getByText("No goals match your filters.")).toBeInTheDocument()
  })

  it("switches to the Analytics section over every goal", async () => {
    const user = userEvent.setup()
    mockGoals = [goal({ id: "g1" }), goal({ id: "g2", status: "completed" })]
    await renderBody()
    await user.click(screen.getByTestId("mobile-goals-section-analytics"))
    expect(screen.getByTestId("mock-analytics-panel")).toHaveAttribute("data-count", "2")
  })

  it("syncs goals on pull-to-refresh", async () => {
    const user = userEvent.setup()
    mockGoals = [goal({ id: "g1" })]
    await renderBody()
    await user.click(screen.getByTestId("ptr-refresh"))
    // The event log rides along: the judge notes and the drawer's Activity read it.
    expect(syncDown).toHaveBeenCalledWith({ only: ["goals", "goalEvents"] })
  })

  it("quotes the latest judge verdict on Overview rows, from the synced event log", async () => {
    const user = userEvent.setup()
    mockGoals = [goal({ id: "g1" }), goal({ id: "g2" })]
    mockJudgeNotes = new Map([["g1", "two tests still red"]])
    await renderBody()
    expect(mockRowContextOptions.at(-1)).toEqual({ judgeNotes: true })
    expect(screen.getByTestId("mobile-goal-judge-g1")).toHaveTextContent("“two tests still red”")
    // No verdict yet: no quote line.
    expect(screen.queryByTestId("mobile-goal-judge-g2")).not.toBeInTheDocument()

    // History is a long list of mostly finished goals; it reads no verdicts.
    await user.click(screen.getByTestId("mobile-goals-section-history"))
    expect(mockRowContextOptions.at(-1)).toEqual({ judgeNotes: false })
    expect(screen.getByTestId("mobile-goal-g1")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-goal-judge-g1")).not.toBeInTheDocument()
  })

  it("swallows a failed refresh", async () => {
    const user = userEvent.setup()
    mockGoals = [goal({ id: "g1" })]
    syncDown.mockRejectedValueOnce(new Error("offline"))
    await renderBody()
    await user.click(screen.getByTestId("ptr-refresh"))
    // No throw — the handler catches. The list is still rendered.
    expect(screen.getByTestId("mobile-goal-g1")).toBeInTheDocument()
  })
})
