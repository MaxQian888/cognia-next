/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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

const squad = { id: "squad-1", name: "Delivery", description: "" }
const store = {
  teams: { "squad-1": squad },
  teammates: {},
  updateTeam: jest.fn(),
  deleteTeam: jest.fn(),
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) => selector(store),
}))

import { SquadDetailPanel } from "./squad-detail-panel"

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
