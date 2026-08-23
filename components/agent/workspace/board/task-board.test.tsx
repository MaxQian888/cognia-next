/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"

import { TaskBoard } from "./task-board"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"
import { toast } from "sonner"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key
    return t
  },
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    createLogger: () => ({ ...child, child: () => child }),
    logger: { ...child, child: () => child },
    loggers: { agent: { ...child, child: () => child } },
  }
})

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: null }) },
}))

// Live status: overrideable without Dexie.
let liveStatusOverride: AgentTeam["status"] | undefined
jest.mock("@/hooks/agent-runs/use-team-live-status", () => ({
  useTeamLiveStatus: (team: { status: AgentTeam["status"] }) => liveStatusOverride ?? team.status,
}))

// Capture DndContext callbacks so drops can be driven synthetically —
// pointer-based drag is not reproducible in jsdom. The drop *decision* logic
// (resolveDrop / canMoveTask) is fully covered in board-model.test.ts.
type DndProps = {
  children?: ReactNode
  onDragStart?: (event: { active: { id: string } }) => void
  onDragEnd?: (event: { active: { id: string }; over: { id: string } | null }) => void
  onDragCancel?: (event: unknown) => void
}
let dndProps: DndProps = {}
jest.mock("@dnd-kit/core", () => ({
  DndContext: (props: DndProps) => {
    dndProps = props
    return <div data-testid="dnd-context">{props.children}</div>
  },
  DragOverlay: ({ children }: { children?: ReactNode }) => (
    <div data-testid="dnd-drag-overlay">{children}</div>
  ),
  PointerSensor: function PointerSensor() {},
  closestCorners: jest.fn(),
  defaultDropAnimationSideEffects: jest.fn(() => jest.fn()),
  useSensor: jest.fn(),
  useSensors: jest.fn(() => []),
  useDroppable: jest.fn(() => ({ setNodeRef: jest.fn(), isOver: false })),
}))
jest.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children?: ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: jest.fn(),
  useSortable: jest.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: jest.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  })),
}))

// Twin catalog: deterministic + keeps Dexie out of the suite.
jest.mock("@/lib/ai/agent/team/twin-context", () => ({
  gatherTeamTwins: jest.fn(async () => [
    { id: "twin-9", name: "Ada", expertise: "frontend" },
    { id: "twin-kb", name: "Kb", expertise: "docs" },
  ]),
}))

// The toolbar's run controls reach the manager facade (whose import graph
// drags in the whole runtime) — stub it.
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    start: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
  },
}))

// The plugin slot pulls in the plugin registry graph — stub it.
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({ point }: { point: string }) => <div data-testid={`slot-${point}`} />,
}))

// TaskComments reads store comment threads — irrelevant here.
jest.mock("../task-comments", () => ({
  TaskComments: () => <div data-testid="task-comments" />,
}))

const seed = () => {
  const state = useAgentTeamStore.getState()
  const team = state.createTeam({ name: "T", task: "t" })
  const mate = state.addTeammate({
    teamId: team.id,
    name: "Worker",
    description: "",
    role: "teammate",
  })
  const pending1 = state.createTask({ teamId: team.id, title: "P1", description: "" })
  const pending2 = state.createTask({ teamId: team.id, title: "P2", description: "" })
  const failed = state.createTask({ teamId: team.id, title: "F1", description: "" })
  state.updateTask(failed.id, { status: "failed", error: "boom" })
  const fresh = useAgentTeamStore.getState()
  return {
    team: fresh.teams[team.id],
    mate,
    pending1,
    pending2,
    failed,
    tasks: () => Object.values(useAgentTeamStore.getState().tasks),
    teammates: [fresh.teammates[mate.id]],
  }
}

const renderBoard = (ctx: ReturnType<typeof seed>) =>
  render(
    <TooltipProvider>
      <TaskBoard team={ctx.team} tasks={ctx.tasks()} teammates={ctx.teammates} />
    </TooltipProvider>
  )

beforeEach(() => {
  useAgentTeamStore.getState().reset()
  liveStatusOverride = undefined
  dndProps = {}
  jest.clearAllMocks()
})

describe("TaskBoard empty state", () => {
  it("replaces the column strip with one team-level empty state when there are no tasks", () => {
    const ctx = seed()
    render(
      <TooltipProvider>
        <TaskBoard team={ctx.team} tasks={[]} teammates={ctx.teammates} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("board-empty")).toBeInTheDocument()
    // Eight columns each repeating "No tasks" reads as broken, not empty.
    expect(screen.queryByTestId("board-columns")).not.toBeInTheDocument()
    expect(screen.queryByTestId("board-swimlanes")).not.toBeInTheDocument()
  })

  it("shows the columns again as soon as a task exists", () => {
    const ctx = seed()
    renderBoard(ctx)
    expect(screen.queryByTestId("board-empty")).not.toBeInTheDocument()
    expect(screen.getByTestId("board-columns")).toBeInTheDocument()
  })
})

describe("TaskBoard", () => {
  it("renders the 8 canonical columns with counts", () => {
    const ctx = seed()
    renderBoard(ctx)
    for (const status of [
      "pending",
      "blocked",
      "claimed",
      "in_progress",
      "review",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(screen.getByTestId(`board-column-${status}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId("board-column-pending-count").textContent).toBe("2")
    expect(screen.getByTestId("board-column-failed-count").textContent).toBe("1")
  })

  it("applies a guarded move on drop (failed → pending retries)", () => {
    const ctx = seed()
    renderBoard(ctx)
    act(() => dndProps.onDragStart?.({ active: { id: ctx.failed.id } }))
    act(() => dndProps.onDragEnd?.({ active: { id: ctx.failed.id }, over: { id: "col:pending" } }))
    const moved = useAgentTeamStore.getState().tasks[ctx.failed.id]
    expect(moved.status).toBe("pending")
    expect(moved.error).toBeUndefined()
  })

  it("surfaces denied drops as a toast and leaves the task in place", () => {
    const ctx = seed()
    renderBoard(ctx)
    act(() =>
      dndProps.onDragEnd?.({ active: { id: ctx.pending1.id }, over: { id: "col:completed" } })
    )
    expect(toast.error).toHaveBeenCalledWith("denied.illegal-transition")
    expect(useAgentTeamStore.getState().tasks[ctx.pending1.id].status).toBe("pending")
  })

  it("reorders within a column when dropping onto a sibling card", () => {
    const ctx = seed()
    renderBoard(ctx)
    act(() =>
      dndProps.onDragEnd?.({ active: { id: ctx.pending1.id }, over: { id: ctx.pending2.id } })
    )
    const tasks = useAgentTeamStore.getState().tasks
    expect(tasks[ctx.pending2.id].order).toBeLessThan(tasks[ctx.pending1.id].order)
  })

  it("switches to read-only swimlanes grouped by owner", async () => {
    const user = userEvent.setup()
    const ctx = seed()
    useAgentTeamStore.getState().assignTask(ctx.pending1.id, ctx.mate.id)
    render(
      <TooltipProvider>
        <TaskBoard
          team={ctx.team}
          tasks={ctx.tasks()}
          teammates={[useAgentTeamStore.getState().teammates[ctx.mate.id]]}
        />
      </TooltipProvider>
    )
    await user.click(screen.getByTestId("board-swimlanes-toggle"))
    expect(screen.getByTestId("board-swimlanes")).toBeInTheDocument()
    expect(screen.getByTestId(`board-lane-${ctx.mate.id}`)).toBeInTheDocument()
    expect(screen.getByTestId("board-lane-unassigned")).toBeInTheDocument()
    // Drag surface is gone in swimlane mode.
    expect(screen.queryByTestId("board-columns")).not.toBeInTheDocument()
  })

  it("shows twin badges on swimlane headers and knowledge-twin chips", async () => {
    const user = userEvent.setup()
    const ctx = seed()
    const state = useAgentTeamStore.getState()
    state.updateTeammate(ctx.mate.id, { config: { twinId: "twin-9" } })
    state.updateTeam(ctx.team.id, {
      config: { ...ctx.team.config, knowledgeTwinIds: ["twin-kb"] },
    })
    state.assignTask(ctx.pending1.id, ctx.mate.id)
    const fresh = useAgentTeamStore.getState()
    render(
      <TooltipProvider>
        <TaskBoard
          team={fresh.teams[ctx.team.id]}
          tasks={ctx.tasks()}
          teammates={[fresh.teammates[ctx.mate.id]]}
        />
      </TooltipProvider>
    )
    // Knowledge twins resolve display names from the twin catalog (async
    // gatherTeamTwins — the chip shows the raw id until the fetch lands).
    await waitFor(() => expect(screen.getByTestId("board-knowledge-twins")).toHaveTextContent("Kb"))
    await user.click(screen.getByTestId("board-swimlanes-toggle"))
    expect(await screen.findByTestId(`board-lane-${ctx.mate.id}-twin`)).toHaveTextContent("Ada")
  })

  describe("drag overlay", () => {
    it("renders no clone until a drag starts", () => {
      renderBoard(seed())
      expect(screen.queryByTestId("task-drag-overlay")).not.toBeInTheDocument()
    })

    it("portals a clone that follows the cursor out of the board's scroll container", () => {
      const ctx = seed()
      renderBoard(ctx)
      act(() => dndProps.onDragStart?.({ active: { id: ctx.pending1.id } } as never))
      const overlay = screen.getByTestId("task-drag-overlay")
      expect(overlay).toHaveTextContent("P1")
      // The point of the portal: it is NOT inside the overflow-x-auto strip.
      expect(screen.getByTestId("board-columns").contains(overlay)).toBe(false)
    })

    it("drops the clone when the drag is cancelled", () => {
      const ctx = seed()
      renderBoard(ctx)
      act(() => dndProps.onDragStart?.({ active: { id: ctx.pending1.id } } as never))
      act(() => dndProps.onDragCancel?.({} as never))
      expect(screen.queryByTestId("task-drag-overlay")).not.toBeInTheDocument()
    })
  })
})
