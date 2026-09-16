/**
 * @jest-environment jsdom
 */

import { render as rtlRender, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { RouterFusionRunMetadata } from "@/lib/chat/message-run-metadata"

import { formatMicrousd, RouterFusionRunCard } from "./router-fusion-run-card"

const render = (ui: React.ReactElement) =>
  rtlRender(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

const route: NonNullable<RouterFusionRunMetadata["route"]> = {
  runId: "rf-run-1",
  decisionId: "dec-1",
  actionId: "direct_baseline",
  mode: "direct",
  ruleId: null,
  deploymentId: "openai::gpt-5",
  providerId: "openai",
  modelId: "gpt-5",
  budgetMode: "tracked",
  capMicrousd: 500_000,
  reserveEstimateMicrousd: 12_000,
  priceKnown: true,
  acceptanceProfile: "text_basic",
  lane: "ai-sdk",
}

const outcome: NonNullable<RouterFusionRunMetadata["outcome"]> = {
  status: "succeeded",
  spentMicrousd: 42_000,
  overspendMicrousd: 0,
  modelCalls: 3,
  costStatus: "actual",
  frozen: false,
  refusalCode: null,
}

describe("RouterFusionRunCard", () => {
  it("formats microusd as dollars, with more precision below a cent", () => {
    expect(formatMicrousd(42_000)).toBe("$0.0420")
    expect(formatMicrousd(4_200)).toBe("$0.004200")
    expect(formatMicrousd(0)).toBe("$0.0000")
  })

  it("[ACC:OFF-02] renders nothing for metadata without a route or a bypass", () => {
    render(<RouterFusionRunCard routerFusion={{}} />)
    expect(screen.queryByTestId("router-fusion-run-card")).toBeNull()
    expect(screen.queryByTestId("router-fusion-bypass")).toBeNull()
  })

  it("shows the booked cost and expands into the route and the ledger's record", async () => {
    const user = userEvent.setup()
    render(<RouterFusionRunCard routerFusion={{ route, outcome }} />)
    const chip = screen.getByTestId("router-fusion-run-card")
    expect(chip).toHaveTextContent("Router + Fusion")
    expect(chip).toHaveTextContent("$0.0420")
    await user.click(chip)
    const details = await screen.findByTestId("router-fusion-run-details")
    expect(details).toHaveTextContent("Succeeded")
    expect(details).toHaveTextContent("direct_baseline")
    expect(details).toHaveTextContent("Baseline (no rule matched)")
    expect(details).toHaveTextContent("openai / gpt-5")
    expect(details).toHaveTextContent("Tracked")
    expect(details).toHaveTextContent("$0.5000")
    expect(details).toHaveTextContent("(actual)")
    expect(details).toHaveTextContent("Format check (schema only")
    expect(details).not.toHaveTextContent("Estimated cap")
  })

  it("says why a refused turn stopped and flags an estimated cap and overspend", async () => {
    const user = userEvent.setup()
    render(
      <RouterFusionRunCard
        routerFusion={{
          route: { ...route, priceKnown: false, ruleId: "R2_economy_simple" },
          outcome: {
            ...outcome,
            status: "failed",
            refusalCode: "RUN_BUDGET_EXHAUSTED",
            overspendMicrousd: 1_500,
            frozen: true,
            costStatus: "estimated",
          },
        }}
      />
    )
    await user.click(screen.getByTestId("router-fusion-run-card"))
    const details = await screen.findByTestId("router-fusion-run-details")
    expect(details).toHaveTextContent("Failed")
    expect(details).toHaveTextContent("The next call would exceed this run's cap.")
    expect(details).toHaveTextContent("R2_economy_simple")
    expect(details).toHaveTextContent("Over cap by $0.001500")
    expect(details).toHaveTextContent("Stopped at the cap")
    expect(details).toHaveTextContent("(estimated)")
    expect(details).toHaveTextContent("Estimated cap")
  })

  it("shows a verified cascade or panel answer's mode and cost, expanding into its run", async () => {
    const user = userEvent.setup()
    const fusion: NonNullable<RouterFusionRunMetadata["fusion"]> = {
      runId: "rf-run-7",
      mode: "panel",
      actionId: "panel_review",
      ruleId: null,
      status: "succeeded",
      qualityStatus: "degraded",
      roles: { judge: "openai::gpt-5" },
      capMicrousd: 2_000_000,
      spentMicrousd: 91_000,
      modelCalls: 4,
      costStatus: "actual",
      errorCode: null,
      timeline: {
        phases: [{ phase: "judge", step: "reported", at: 1 }],
        calls: { started: 4, finished: 4, unknown: 0 },
        candidates: { members: 2, rejected: 1, evidenceRejected: 0 },
        judge: null,
        escalated: null,
        degraded: { reason: "FUSION_INSUFFICIENT_CANDIDATES" },
        verification: null,
        compactions: 0,
      },
    }
    render(<RouterFusionRunCard routerFusion={{ fusion }} />)
    const chip = screen.getByTestId("router-fusion-run-card")
    expect(chip).toHaveTextContent("Panel")
    expect(chip).toHaveTextContent("$0.0910")
    // A degraded answer is flagged on the chip itself.
    expect(chip.className).toContain("text-amber-600")
    await user.click(chip)
    const details = await screen.findByTestId("router-fusion-run-details")
    expect(details).toHaveTextContent("Only one panel answer survived")
    expect(details).toHaveTextContent("Judge reported")
    expect(details).not.toHaveTextContent("Runtime")
  })

  it("names a reviewed turn's check without calling it schema only", async () => {
    const user = userEvent.setup()
    render(
      <RouterFusionRunCard
        routerFusion={{ route: { ...route, acceptanceProfile: "text_review" }, outcome }}
      />
    )
    await user.click(screen.getByTestId("router-fusion-run-card"))
    const details = await screen.findByTestId("router-fusion-run-details")
    expect(details).toHaveTextContent("Model review")
    expect(details).not.toHaveTextContent("schema only")
  })

  it("[ACC:ISO-01] marks a turn that ran unledgered on the original path", async () => {
    const user = userEvent.setup()
    render(
      <RouterFusionRunCard
        routerFusion={{ bypass: { code: "db_unavailable", justTripped: false } }}
      />
    )
    const chip = screen.getByTestId("router-fusion-bypass")
    expect(chip).toHaveTextContent("Not ledgered")
    await user.hover(chip)
    expect(
      (await screen.findAllByText(/Router \+ Fusion was unavailable \(db_unavailable\)/)).length
    ).toBeGreaterThan(0)
  })
})
