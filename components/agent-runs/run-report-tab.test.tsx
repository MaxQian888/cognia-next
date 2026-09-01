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

const rosterSeen: string[][] = []
jest.mock("@/components/agent/workspace/activity-report", () => ({
  ReportKpiCards: () => <div data-testid="report-kpi" />,
  ReportTokenBurn: () => <div data-testid="report-burn" />,
  ReportTaskline: ({ teammates }: { teammates: Array<{ id: string }> }) => {
    rosterSeen.push(teammates.map((m) => m.id))
    return <div data-testid="report-taskline" />
  },
  ReportPluginSlot: () => <div data-testid="report-plugin-slot" />,
}))

const store = {
  teams: {} as Record<string, { executionReport?: unknown }>,
  teammates: {} as Record<string, { id: string; teamId: string }>,
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) => selector(store),
}))

import { RunReportTab } from "./run-report-tab"

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

describe("RunReportTab", () => {
  beforeEach(() => {
    rosterSeen.length = 0
    teamRun = { id: "atr-1", teamId: "squad-1" }
    store.teams = { "squad-1": { executionReport: { id: "rep-1", teamId: "squad-1" } } }
    store.teammates = {
      "m-1": { id: "m-1", teamId: "squad-1" },
      "m-2": { id: "m-2", teamId: "squad-2" },
    }
  })

  /**
   * Four built components and the `agent.team.report` extension point had no
   * host after `/agent-teams/workspace` was retired. A plugin could register
   * here and never render, with `audit:slots` green because it scans files
   * rather than the render graph.
   */
  it("renders the report and its plugin slot", () => {
    render(<RunReportTab row={row()} />)
    expect(screen.getByTestId("report-kpi")).toBeInTheDocument()
    expect(screen.getByTestId("report-burn")).toBeInTheDocument()
    expect(screen.getByTestId("report-taskline")).toBeInTheDocument()
    expect(screen.getByTestId("report-plugin-slot")).toBeInTheDocument()
  })

  /**
   * `TeamExecutionReport` carries no run id, so the store holds one report per
   * Squad. The tab must not let a reader believe it belongs to this run.
   */
  it("says the report is the Squad's latest, not this run's", () => {
    render(<RunReportTab row={row()} />)
    expect(screen.getByTestId("run-report-scope")).toBeInTheDocument()
  })

  it("passes only this Squad's roster to the taskline", () => {
    render(<RunReportTab row={row()} />)
    expect(rosterSeen[0]).toEqual(["m-1"])
  })

  /**
   * Mobile syncs `executionRuns` and nothing else, so the Squad run record is
   * simply absent there. An empty report would claim the run produced none.
   */
  it("says the device lacks the record rather than rendering an empty report", () => {
    teamRun = undefined
    render(<RunReportTab row={row()} />)
    expect(screen.getByTestId("run-report-unavailable")).toBeInTheDocument()
    expect(screen.queryByTestId("report-kpi")).not.toBeInTheDocument()
  })

  it("distinguishes no report yet from no record", () => {
    store.teams = { "squad-1": {} }
    render(<RunReportTab row={row()} />)
    expect(screen.getByTestId("run-report-none")).toBeInTheDocument()
  })

  /** While a team run is live the row can arrive with no `runId` at all. */
  it("resolves the run from sourceId, never runId", () => {
    render(<RunReportTab row={row({ runId: undefined })} />)
    expect(screen.getByTestId("run-report")).toBeInTheDocument()
  })
})
