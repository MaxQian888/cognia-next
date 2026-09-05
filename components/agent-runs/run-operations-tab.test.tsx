/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

let teamRun: { id: string; teamId: string } | undefined
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => teamRun,
}))
jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: jest.fn(),
}))

const mounted: Array<{ teamId: string; runId?: string }> = []
let capturedProps: Record<string, (arg?: unknown) => void> = {}
jest.mock("@/components/agent/workspace/durable-operations", () => ({
  DurableOperations: (props: {
    team: { id: string }
    runId?: string
    onOpenEditor: () => void
    onOpenTerminal: () => void
    onOpenBrowser: () => void
    onMigrate: (c: unknown) => void
  }) => {
    mounted.push({ teamId: props.team.id, runId: props.runId })
    capturedProps = props as never
    return <div data-testid="durable-operations" />
  },
}))

const updateTeam = jest.fn()
const store = {
  teams: { "squad-1": { id: "squad-1", config: {} } } as Record<string, unknown>,
  updateTeam,
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) => selector(store),
}))

import { RunOperationsTab } from "./run-operations-tab"

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

describe("RunOperationsTab", () => {
  beforeEach(() => {
    mounted.length = 0
    push.mockClear()
    updateTeam.mockClear()
    teamRun = { id: "atr-7", teamId: "squad-1" }
    store.teams = { "squad-1": { id: "squad-1", config: {} } }
  })

  /**
   * `DurableOperations` picks the Squad's NEWEST run when given no `runId`.
   * That was right in a workspace showing one Squad and wrong in a cockpit that
   * reads one run at a time: the panel would answer about a different run than
   * the one the reader opened.
   */
  it("names the run the reader opened, not the Squad's newest", () => {
    render(<RunOperationsTab row={row()} />)
    expect(mounted).toEqual([{ teamId: "squad-1", runId: "atr-7" }])
  })

  /** The callbacks pointed at tabs of a route that no longer exists. */
  it("routes the open affordances somewhere that still exists", () => {
    render(<RunOperationsTab row={row()} />)
    capturedProps.onOpenEditor!()
    expect(push).toHaveBeenCalledWith("/workspace")
    capturedProps.onOpenTerminal!()
    expect(push).toHaveBeenCalledWith("/workspace")
    capturedProps.onOpenBrowser!()
    expect(push).toHaveBeenCalledWith("/browser")
  })

  it("says the device lacks the record rather than rendering empty controls", () => {
    teamRun = undefined
    render(<RunOperationsTab row={row()} />)
    expect(screen.getByTestId("run-operations-unavailable")).toBeInTheDocument()
    expect(screen.queryByTestId("durable-operations")).not.toBeInTheDocument()
  })

  it("refuses when the run names a Squad this device does not have", () => {
    store.teams = {}
    render(<RunOperationsTab row={row()} />)
    expect(screen.getByTestId("run-operations-unavailable")).toBeInTheDocument()
  })
})
