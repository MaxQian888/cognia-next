/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let teamRun: { id: string; teamId: string } | undefined
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => teamRun,
}))
jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: jest.fn(),
}))

const consensusTeamIds: (string | undefined)[] = []
const delegationTeamIds: (string | undefined)[] = []
jest.mock("@/components/agent/workspace/consensus-panel", () => ({
  ConsensusPanel: ({ teamId }: { teamId?: string }) => {
    consensusTeamIds.push(teamId)
    return <div data-testid="consensus-panel" />
  },
}))
jest.mock("@/components/agent/workspace/delegations-panel", () => ({
  DelegationsPanel: ({ teamId }: { teamId?: string }) => {
    delegationTeamIds.push(teamId)
    return <div data-testid="delegations-panel" />
  },
}))

import { isSquadRun, RunCoordinationTab } from "./run-coordination-tab"

const row = (over: Record<string, unknown> = {}) =>
  ({
    rowId: "r1",
    kind: "team",
    label: "Ship it",
    status: "running",
    startedAt: 0,
    source: "broker",
    sourceId: "atr-1",
    ...over,
  }) as never

describe("isSquadRun", () => {
  it("is true only for a team run", () => {
    expect(isSquadRun(row())).toBe(true)
    expect(isSquadRun(row({ kind: "workflow" }))).toBe(false)
    expect(isSquadRun(row({ kind: "chat" }))).toBe(false)
  })
})

describe("RunCoordinationTab", () => {
  beforeEach(() => {
    consensusTeamIds.length = 0
    delegationTeamIds.length = 0
    teamRun = { id: "atr-1", teamId: "team-9" }
  })

  /**
   * The trap `monitor-model` documents: while a team run is live the row can be
   * `source: "broker"` with no `runId` at all, so a section keyed on `runId` is
   * blank exactly while the run is worth looking at.
   */
  it("names the team from the run record, on a row that has no runId", () => {
    render(<RunCoordinationTab row={row({ runId: undefined })} />)
    expect(consensusTeamIds).toEqual(["team-9"])
    expect(delegationTeamIds).toEqual(["team-9"])
  })

  /**
   * Mobile syncs `executionRuns` and nothing else, so the team-run record is
   * simply absent there. An empty consensus list would claim the run reached no
   * decisions, which is a different statement.
   */
  it("says the record is not here rather than rendering an empty list", () => {
    teamRun = undefined
    render(<RunCoordinationTab row={row()} />)
    expect(screen.getByTestId("run-coordination-unavailable")).toBeInTheDocument()
    expect(screen.queryByTestId("consensus-panel")).not.toBeInTheDocument()
  })
})
