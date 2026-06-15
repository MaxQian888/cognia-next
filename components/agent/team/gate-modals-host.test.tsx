/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import { GateModalsHost } from "./gate-modals-host"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeammate } from "@/types/agent/agent-team"

const approveMock = jest.fn()
const rejectMock = jest.fn()
jest.mock("@/lib/runtime/approval-bus", () => ({
  approve: (...args: unknown[]) => approveMock(...args),
  reject: (...args: unknown[]) => rejectMock(...args),
}))

const renderHost = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <GateModalsHost />
    </NextIntlClientProvider>
  )

const openGate = (over: Partial<Parameters<typeof usePendingGatesStore.getState>[0]> = {}) =>
  act(() => {
    usePendingGatesStore.getState().open({
      key: { scope: "agent-team-budget", id: "run-1" },
      gateType: "budget",
      title: "Budget",
      runId: "run-1",
      teamId: "team-1",
      ...(over as object),
    })
  })

beforeEach(() => {
  approveMock.mockClear()
  rejectMock.mockClear()
  act(() => {
    usePendingGatesStore.setState({ gates: [] })
    useAgentTeamStore.setState({ teammates: {} })
  })
})

describe("GateModalsHost", () => {
  it("renders nothing when no gates are open", () => {
    const { container } = renderHost()
    expect(container).toBeEmptyDOMElement()
  })

  it("renders a dialog per open gate", () => {
    renderHost()
    openGate()
    expect(screen.getByText(/Token budget critical/i)).toBeInTheDocument()
  })

  it("approve resolves the bus waiter and removes the gate", () => {
    renderHost()
    openGate()
    fireEvent.change(screen.getByPlaceholderText(/50000/), { target: { value: "1000" } })
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }))
    expect(approveMock).toHaveBeenCalledWith(
      { scope: "agent-team-budget", id: "run-1" },
      { extraTokens: 1000 }
    )
    expect(usePendingGatesStore.getState().gates).toHaveLength(0)
  })

  it("reject resolves the bus waiter and removes the gate", () => {
    renderHost()
    openGate()
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }))
    expect(rejectMock).toHaveBeenCalledWith({ scope: "agent-team-budget", id: "run-1" }, undefined)
    expect(usePendingGatesStore.getState().gates).toHaveLength(0)
  })

  it("feeds the team's teammates as deadlock reset candidates", () => {
    act(() => {
      useAgentTeamStore.setState({
        teammates: {
          tm1: { id: "tm1", name: "Scout", teamId: "team-1" } as AgentTeammate,
          tmOther: { id: "tmOther", name: "Other", teamId: "team-2" } as AgentTeammate,
        },
      })
    })
    renderHost()
    openGate({ key: { scope: "agent-team-deadlock", id: "run-1" }, gateType: "deadlock" })
    // The per-teammate candidate list shows by default (resetAll starts false).
    expect(screen.getByLabelText("Scout")).toBeInTheDocument()
    expect(screen.queryByLabelText("Other")).not.toBeInTheDocument()
  })

  it("renders one dialog per gate when multiple are open", () => {
    renderHost()
    openGate()
    openGate({ key: { scope: "agent-team-deadlock", id: "run-1" }, gateType: "deadlock" })
    expect(screen.getByText(/Token budget critical/i)).toBeInTheDocument()
    expect(screen.getByText(/All teammates unavailable/i)).toBeInTheDocument()
  })

  it("renders a replan gate and approves with no payload", () => {
    renderHost()
    act(() => {
      usePendingGatesStore.getState().open({
        key: { scope: "agent-team-replan", id: "run-1" },
        gateType: "replan",
        title: "Re-plan",
        body: "tighten the scope",
        runId: "run-1",
        teamId: "team-1",
      })
    })
    expect(screen.getByText(/Re-plan checkpoint/i)).toBeInTheDocument()
    expect(screen.getByText("tighten the scope")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }))
    expect(approveMock).toHaveBeenCalledWith({ scope: "agent-team-replan", id: "run-1" }, undefined)
  })
})
