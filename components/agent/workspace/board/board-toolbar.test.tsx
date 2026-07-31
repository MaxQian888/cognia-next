/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { BoardToolbar } from "./board-toolbar"
import { EMPTY_BOARD_FILTER, type BoardFilter } from "@/lib/ai/agent/team/board-model"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key
    return t
  },
}))

jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    start: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
  },
}))

let liveStatusOverride: AgentTeam["status"] | undefined
jest.mock("@/hooks/agent-runs/use-team-live-status", () => ({
  useTeamLiveStatus: (team: { status: AgentTeam["status"] }) => liveStatusOverride ?? team.status,
}))

let slotPoints: Array<{ point: string; context?: Record<string, unknown> }> = []
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: (props: { point: string; context?: Record<string, unknown> }) => {
    slotPoints.push(props)
    return <div data-testid={`slot-${props.point}`} />
  },
}))

const team = {
  id: "t1",
  name: "T",
  status: "idle",
  config: { maxConcurrentTeammates: 2 },
} as AgentTeam

const mate = { id: "w1", name: "Worker One" } as AgentTeammate

const task = (id: string, overrides: Partial<AgentTeamTask> = {}): AgentTeamTask =>
  ({
    id,
    teamId: "t1",
    title: id,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    createdAt: new Date(),
    order: 0,
    ...overrides,
  }) as AgentTeamTask

const renderToolbar = (
  filter: BoardFilter = EMPTY_BOARD_FILTER,
  onFilterChange = jest.fn(),
  tasks = [
    task("a", { tags: ["ui"], assignedTo: "w1" }),
    task("b", { status: "in_progress" }),
    task("c", { status: "claimed" }),
    task("d", { status: "in_progress" }),
  ]
) => {
  render(
    <BoardToolbar
      team={team}
      tasks={tasks}
      teammates={[mate]}
      filter={filter}
      onFilterChange={onFilterChange}
      swimlanes={false}
      onSwimlanesChange={jest.fn()}
    />
  )
  return onFilterChange
}

beforeEach(() => {
  liveStatusOverride = undefined
  slotPoints = []
  jest.clearAllMocks()
})

describe("BoardToolbar", () => {
  it("shows the WIP hint (3 active vs capacity 2 → over)", () => {
    renderToolbar()
    expect(screen.getByTestId("board-wip-hint").textContent).toBe("wip")
    // Over-capacity renders the destructive badge with the explanation title.
    expect(screen.getByTestId("board-wip-hint")).toHaveAttribute("title", "wipOver")
  })

  it("toggles a priority filter via the dropdown", async () => {
    const user = userEvent.setup()
    const onFilterChange = renderToolbar()
    await user.click(screen.getByTestId("board-filter-trigger"))
    await user.click(await screen.findByTestId("board-filter-priority-high"))
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ priorities: ["high"] }))
  })

  it("offers tag + assignee options from the task set", async () => {
    const user = userEvent.setup()
    const onFilterChange = renderToolbar()
    await user.click(screen.getByTestId("board-filter-trigger"))
    await user.click(await screen.findByTestId("board-filter-tag-ui"))
    expect(onFilterChange).toHaveBeenCalledWith(expect.objectContaining({ tags: ["ui"] }))
    await user.click(screen.getByTestId("board-filter-trigger"))
    expect((await screen.findByTestId("board-filter-assignee-w1")).textContent).toContain(
      "Worker One"
    )
  })

  it("clears active filters", async () => {
    const user = userEvent.setup()
    const onFilterChange = renderToolbar({ ...EMPTY_BOARD_FILTER, tags: ["ui"] })
    await user.click(screen.getByTestId("board-filter-clear"))
    expect(onFilterChange).toHaveBeenCalledWith(EMPTY_BOARD_FILTER)
  })

  it("drives run/pause/resume from the live status", async () => {
    const user = userEvent.setup()
    renderToolbar()
    await user.click(screen.getByTestId("board-run"))
    expect(agentTeamManager.start).toHaveBeenCalledWith("t1")
  })

  it("shows Pause while executing and Resume while paused", async () => {
    const user = userEvent.setup()
    liveStatusOverride = "executing"
    renderToolbar()
    await user.click(screen.getByTestId("board-pause"))
    expect(agentTeamManager.pause).toHaveBeenCalledWith("t1")
  })

  it("shows Resume while paused", async () => {
    const user = userEvent.setup()
    liveStatusOverride = "paused"
    renderToolbar()
    await user.click(screen.getByTestId("board-resume"))
    expect(agentTeamManager.resume).toHaveBeenCalledWith("t1")
  })

  it("mounts the agent.team.board.toolbar plugin slot with teamId + filter", () => {
    const filter = { ...EMPTY_BOARD_FILTER, tags: ["ui"] }
    renderToolbar(filter)
    const slot = slotPoints.find((s) => s.point === "agent.team.board.toolbar")
    expect(slot?.context).toEqual({ teamId: "t1", filter })
  })
})
