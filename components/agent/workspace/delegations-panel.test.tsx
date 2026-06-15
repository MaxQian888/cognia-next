/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { TeamDelegationRecord } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const approveDelegationMock = jest.fn()
const cancelDelegationMock = jest.fn()
jest.mock("@/lib/ai/agent/team/delegation-orchestrator", () => ({
  approveDelegation: (...args: unknown[]) => approveDelegationMock(...args),
  cancelDelegation: (...args: unknown[]) => cancelDelegationMock(...args),
}))

let mockDelegations: TeamDelegationRecord[] = []

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({ delegations: {}, teams: {}, activeTeamId: null }),
}))

jest.mock("@/stores/agent/agent-team-store/selectors", () => ({
  selectActiveTeamDelegations: () => mockDelegations,
}))

import { DelegationsPanel } from "./delegations-panel"

function makeDelegation(overrides: Partial<TeamDelegationRecord> = {}): TeamDelegationRecord {
  return {
    id: "d1",
    sourceTeamId: "team-1",
    sourceTaskId: "task-1",
    targetType: "background",
    status: "active",
    reason: "Offload research",
    manual: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  }
}

describe("DelegationsPanel", () => {
  beforeEach(() => {
    approveDelegationMock.mockReset()
    cancelDelegationMock.mockReset()
    mockDelegations = []
  })

  it("shows the empty hint when there are no delegations", () => {
    render(<DelegationsPanel />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders an active delegation with a cancel button (no approve)", () => {
    mockDelegations = [makeDelegation()]
    render(<DelegationsPanel />)
    expect(screen.getByText("Offload research")).toBeInTheDocument()
    expect(screen.getByText("cancel")).toBeInTheDocument()
    expect(screen.queryByText("approve")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("cancel"))
    expect(cancelDelegationMock).toHaveBeenCalledWith("d1")
  })

  it("shows approve + cancel for an awaiting_approval delegation and wires both", () => {
    mockDelegations = [makeDelegation({ id: "d2", status: "awaiting_approval" })]
    render(<DelegationsPanel />)
    fireEvent.click(screen.getByText("approve"))
    expect(approveDelegationMock).toHaveBeenCalledWith("d2")
    fireEvent.click(screen.getByText("cancel"))
    expect(cancelDelegationMock).toHaveBeenCalledWith("d2")
  })

  it("hides action buttons and surfaces the error for a settled delegation", () => {
    mockDelegations = [makeDelegation({ id: "d3", status: "failed", error: "boom" })]
    render(<DelegationsPanel />)
    expect(screen.queryByText("cancel")).not.toBeInTheDocument()
    expect(screen.queryByText("approve")).not.toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("renders settled statuses (pending / completed / timeout) without action buttons", () => {
    mockDelegations = [
      makeDelegation({ id: "p", status: "pending", reason: "Pending one" }),
      makeDelegation({ id: "c", status: "completed", reason: "Completed one" }),
      makeDelegation({ id: "t", status: "timeout", reason: "Timed out one" }),
    ]
    render(<DelegationsPanel />)
    expect(screen.getByText("Pending one")).toBeInTheDocument()
    expect(screen.getByText("Completed one")).toBeInTheDocument()
    expect(screen.getByText("Timed out one")).toBeInTheDocument()
    // pending is still in-flight → shows a cancel; completed/timeout are settled.
    expect(screen.getAllByText("cancel")).toHaveLength(1)
  })

  it("orders delegations newest-first", () => {
    mockDelegations = [
      makeDelegation({ id: "old", reason: "Older", createdAt: new Date("2026-01-01") }),
      makeDelegation({ id: "new", reason: "Newer", createdAt: new Date("2026-02-01") }),
    ]
    render(<DelegationsPanel />)
    const reasons = screen.getAllByText(/Older|Newer/).map((el) => el.textContent)
    expect(reasons[0]).toBe("Newer")
  })
})
