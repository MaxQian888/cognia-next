/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/hooks/squads/use-squad-readiness", () => ({
  useSquadReadiness: () => ({ ready: true, loading: false, blockers: [], evaluatedAt: 1 }),
}))
jest.mock("@/components/squads/squad-readiness-card", () => ({
  SquadReadinessCard: ({ squadId }: { squadId: string }) => (
    <div data-testid="squad-readiness" data-squad={squadId} />
  ),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

/**
 * Stubbed rather than rendered: the real composition is nine sections over the
 * store, and what this file pins is that the group is mounted and collapsed,
 * not what is inside it. `settings.test.tsx` covers the contents.
 */
jest.mock("@/components/agent/workspace/settings", () => ({
  AgentTeamSettings: ({ team }: { team: { id: string } }) => (
    <div data-testid="agent-team-settings">{team.id}</div>
  ),
}))

/**
 * Stubbed for the same reason: what this file pins is that the ROSTER EDITOR is
 * mounted rather than a read-only list. `members.test.tsx` covers the editor.
 */
jest.mock("@/components/agent/workspace/members", () => ({
  AgentTeamMembers: ({ team, leadId }: { team: { id: string }; leadId: string }) => (
    <div data-testid="agent-team-members">{`${team.id}/${leadId}`}</div>
  ),
}))

const slotMounts: Array<{ point: string; context: Record<string, unknown> }> = []
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: (props: { point: string; context: Record<string, unknown> }) => {
    slotMounts.push({ point: props.point, context: props.context })
    return <div data-testid={`slot-${props.point}`} />
  },
}))

const squad = { id: "squad-1", name: "Delivery", description: "", leadId: "lead-1", status: "idle" }
const store = {
  teams: { "squad-1": squad },
  teammates: {
    "lead-1": { id: "lead-1", teamId: "squad-1", name: "Lead", role: "lead", status: "idle" },
    "w-1": { id: "w-1", teamId: "squad-1", name: "Worker", role: "teammate", status: "idle" },
  },
  tasks: {
    "t-1": { id: "t-1", teamId: "squad-1", status: "completed" },
    "t-2": { id: "t-2", teamId: "squad-1", status: "pending" },
    "t-other": { id: "t-other", teamId: "squad-2", status: "completed" },
  },
  updateTeam: jest.fn(),
  deleteTeam: jest.fn(),
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) => selector(store),
}))

import { SquadDetailPanel } from "./squad-detail-panel"

describe("SquadDetailPanel roster", () => {
  beforeEach(() => {
    slotMounts.length = 0
  })

  /**
   * Adding, removing and configuring a teammate lived only in a tab of
   * `/agent-teams/workspace`. When ADR-0140 retired that route the affordance
   * went with it and a Squad made with "New Squad" could never gain a member,
   * because template instantiation was the only remaining writer.
   */
  it("mounts the real roster editor, not a read-only list", () => {
    render(<SquadDetailPanel squadId="squad-1" />)
    expect(screen.getByTestId("agent-team-members")).toHaveTextContent("squad-1/lead-1")
  })

  /**
   * `agent.team.panel` declared `workspace/overview.tsx` as its host, and
   * nothing rendered that file after the route died, so a plugin could
   * register a governance panel that never appeared. `audit:slots` stayed green
   * because it scans files, not the render graph.
   */
  it("hosts the squad governance plugin slot", () => {
    render(<SquadDetailPanel squadId="squad-1" />)
    expect(screen.getByTestId("slot-agent.team.panel")).toBeInTheDocument()
  })

  /** Ids and counts only: never a task title or a message body. */
  it("gives the slot counts derived from the tasks, not from `taskIds`", () => {
    render(<SquadDetailPanel squadId="squad-1" />)
    expect(slotMounts[0]!.context).toEqual({
      teamId: "squad-1",
      status: "idle",
      teammateCount: 1,
      taskCount: 2,
      completedTaskCount: 1,
    })
  })
})

describe("SquadDetailPanel advanced governance", () => {
  /**
   * Nine sections of squad configuration were editable only from a tab of
   * `/agent-teams/workspace`, which ADR-0140 retired and took out of
   * navigation. Without a home here they become unreachable when the route
   * goes.
   */
  it("carries the governance sections the retired workspace owned", async () => {
    render(<SquadDetailPanel squadId="squad-1" />)
    await userEvent.click(screen.getByTestId("squad-advanced-toggle"))
    expect(screen.getByTestId("agent-team-settings")).toHaveTextContent("squad-1")
  })

  /**
   * This panel's own header refuses to fan the deep knobs out across the
   * library. One collapsed group is the compromise, so it must start closed.
   */
  it("keeps them collapsed until asked for", () => {
    render(<SquadDetailPanel squadId="squad-1" />)
    expect(screen.queryByTestId("agent-team-settings")).not.toBeInTheDocument()
  })

  /** Deletion lives here, and only here. */
  it("is the one delete path for a squad", async () => {
    render(<SquadDetailPanel squadId="squad-1" />)
    expect(screen.getByTestId("squad-delete")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("squad-advanced-toggle"))
    expect(screen.getAllByTestId("squad-delete")).toHaveLength(1)
  })
})
