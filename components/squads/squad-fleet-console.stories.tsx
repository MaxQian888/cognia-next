import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { SquadFleetConsole } from "./squad-fleet-console"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import type { AgentTeam, AgentTeammate, TeamStatus } from "@/types/agent/agent-team"

function squad(id: string, name: string, status: TeamStatus, description = ""): AgentTeam {
  return {
    id,
    name,
    description,
    status,
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    config: {},
  } as unknown as AgentTeam
}

function member(id: string, teamId: string): AgentTeammate {
  return { id, teamId, name: id, status: "idle", progress: 0 } as unknown as AgentTeammate
}

const FLEET = [
  squad(
    "research",
    "Research Squad",
    "executing",
    "Reads the codebase and writes up what it finds."
  ),
  squad(
    "refactor",
    "Refactor Crew",
    "planning",
    "Turns an agreed plan into a series of small changes."
  ),
  squad("release", "Release Readiness", "idle", "Runs the pre-release checklist end to end."),
  squad("triage", "Triage", "paused", ""),
]

const MEMBERS = [
  ...["r1", "r2", "r3"].map((id) => member(id, "research")),
  ...["f1", "f2"].map((id) => member(id, "refactor")),
]

function seed(teams: AgentTeam[], members: AgentTeammate[] = [], waitingOn: string[] = []) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])) as never,
    teammates: Object.fromEntries(members.map((m) => [m.id, m])) as never,
  })
  usePendingGatesStore.setState({
    gates: waitingOn.map((teamId, i) => ({
      key: { scope: "team", id: `g${i}` },
      gateType: "plan",
      title: "Approve the plan",
      teamId,
      openedAt: 0,
      status: "open",
    })) as never,
  })
}

const meta = {
  title: "Squads/SquadFleetConsole",
  component: SquadFleetConsole,
  args: { onSelect: () => undefined },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The `/squads` fleet: what every Squad is doing now, plus the controls that act on several at once. Runtime only — configuring a Squad is Settings' job, and the inspector links there rather than growing a second editor. The centre pane is the live command centre, which needs Dexie, so it renders empty here.",
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SquadFleetConsole>

export default meta
type Story = StoryObj<typeof meta>

/** Working Squads sort to the top — a fleet view is read for what is happening. */
export const Fleet: Story = {
  decorators: [
    (Story) => {
      seed(FLEET, MEMBERS)
      return <Story />
    },
  ],
}

/**
 * A Squad blocked on an approval sorts above a working one and wears the badge.
 * It is the only row on the page that will not move until someone answers it,
 * and burying it under an alphabetically earlier idle Squad hides the one
 * actionable thing here.
 */
export const WaitingOnYou: Story = {
  decorators: [
    (Story) => {
      seed(FLEET, MEMBERS, ["release"])
      return <Story />
    },
  ],
}

/** The board tab, with a Squad chosen. */
export const TaskBoard: Story = {
  args: { selectedId: "research", tab: "board" },
  decorators: [
    (Story) => {
      seed(FLEET, MEMBERS)
      return <Story />
    },
  ],
}

/** The board belongs to one Squad, so it asks for one first. */
export const BoardWithoutSelection: Story = {
  args: { tab: "board" },
  decorators: [
    (Story) => {
      seed(FLEET, MEMBERS)
      return <Story />
    },
  ],
}

/** With one selected, the right pane opens on its runs. */
export const SquadSelected: Story = {
  args: { selectedId: "research" },
  decorators: [
    (Story) => {
      seed(FLEET, MEMBERS)
      return <Story />
    },
  ],
}

/** Nothing to fly yet — says where Squads come from. */
export const EmptyFleet: Story = {
  decorators: [
    (Story) => {
      seed([])
      return <Story />
    },
  ],
}
