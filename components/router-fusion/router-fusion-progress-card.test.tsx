/**
 * @jest-environment jsdom
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { RouterFusionRunSummary } from "@cognia/agent-config-types"

import { useFusionProgressStore } from "@/stores/chat/fusion-progress-store"

import { RouterFusionProgressCard } from "./router-fusion-progress-card"

const summary: RouterFusionRunSummary = {
  runId: "r1",
  mode: "cascade",
  actionId: "cascade_schema",
  ruleId: "R1_explicit_mode",
  status: "running",
  qualityStatus: null,
  roles: { cheap: "a::fast", strong: "b::strong" },
  capMicrousd: 1_000_000,
  spentMicrousd: 3_000,
  modelCalls: 2,
  costStatus: "pending",
  errorCode: null,
  timeline: {
    phases: [
      { phase: "cascade", step: "cheap", at: 1 },
      { phase: "cascade", step: "escalate", at: 2 },
    ],
    calls: { started: 2, finished: 1, unknown: 0 },
    candidates: { members: null, rejected: 0, evidenceRejected: 0 },
    judge: null,
    escalated: { reason: "VERIFICATION_FAILED" },
    degraded: null,
    verification: null,
    compactions: 0,
  },
}

beforeEach(() => useFusionProgressStore.setState({ bySession: {} }))

describe("RouterFusionProgressCard", () => {
  it("[ACC:OFF-02] renders nothing without a fusion run in flight", () => {
    render(<RouterFusionProgressCard sessionId="s1" />)
    expect(screen.queryByTestId("router-fusion-progress")).toBeNull()
    render(<RouterFusionProgressCard sessionId={null} />)
    expect(screen.queryByTestId("router-fusion-progress")).toBeNull()
  })

  it("shows a starting run against its cap before the first journal fold", () => {
    useFusionProgressStore
      .getState()
      .start("s1", { runId: "r1", mode: "panel", startedAt: 1, capMicrousd: 2_000_000 })
    render(<RouterFusionProgressCard sessionId="s1" />)
    const card = screen.getByTestId("router-fusion-progress")
    expect(card).toHaveTextContent("Panel running · Starting")
    expect(card).toHaveTextContent("The answer appears once it is verified.")
    expect(card).toHaveTextContent("$0.0000 of $2.0000")
    expect(screen.queryByTestId("router-fusion-progress-details-trigger")).toBeNull()
  })

  it("follows the run's phase, calls and spend, and expands into its details", async () => {
    const user = userEvent.setup()
    useFusionProgressStore
      .getState()
      .start("s1", { runId: "r1", mode: "cascade", startedAt: 1, capMicrousd: 1_000_000 })
    render(<RouterFusionProgressCard sessionId="s1" />)
    act(() => useFusionProgressStore.getState().update("s1", summary))
    const card = screen.getByTestId("router-fusion-progress")
    expect(card).toHaveTextContent("Cascade running · Escalated to the strong model")
    expect(card).toHaveTextContent("2 model calls · $0.003000 of $1.0000")
    await user.click(screen.getByTestId("router-fusion-progress-details-trigger"))
    const details = await screen.findByTestId("router-fusion-progress-details")
    expect(details).toHaveTextContent("The draft failed verification")
    expect(details).toHaveTextContent("Strong draft")

    act(() => useFusionProgressStore.getState().clear("s1"))
    expect(screen.queryByTestId("router-fusion-progress")).toBeNull()
  })
})
