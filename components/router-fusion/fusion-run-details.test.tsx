/**
 * @jest-environment jsdom
 */

import { render, screen, within } from "@testing-library/react"
import type { RouterFusionRunSummary } from "@cognia/agent-config-types"

import { formatMicrousd, FusionRunDetails } from "./fusion-run-details"

function summary(over: Partial<RouterFusionRunSummary> = {}): RouterFusionRunSummary {
  return {
    runId: "rf-run-9",
    mode: "panel",
    actionId: "panel_review",
    ruleId: "R1_explicit_mode",
    status: "succeeded",
    qualityStatus: "accepted",
    roles: {
      panel_a: "openai::gpt-5-mini",
      panel_c: "google::gemini",
      judge: "anthropic::claude-sonnet",
      scout: "local::llama",
    },
    capMicrousd: 2_000_000,
    spentMicrousd: 91_000,
    modelCalls: 5,
    costStatus: "actual",
    errorCode: null,
    timeline: {
      phases: [
        { phase: "prepare", step: null, at: 1 },
        { phase: "panel", step: "candidates", at: 2 },
        { phase: "judge", step: "reported", at: 3 },
        { phase: "synthesis", step: null, at: 4 },
        { phase: "later_phase", step: "new_step", at: 5 },
      ],
      calls: { started: 5, finished: 5, unknown: 0 },
      candidates: { members: 2, rejected: 1, evidenceRejected: 0 },
      judge: { supported: 3, rejected: 1, unverified: 1, contradictions: 2, unresolved: 1 },
      escalated: null,
      degraded: null,
      verification: { status: "passed", level: "model_review" },
      compactions: 0,
    },
    ...over,
  }
}

describe("FusionRunDetails", () => {
  it("formats microusd as dollars, with more precision below a cent", () => {
    expect(formatMicrousd(91_000)).toBe("$0.0910")
    expect(formatMicrousd(900)).toBe("$0.000900")
    expect(formatMicrousd(-5)).toBe("$0.0000")
  })

  it("shows a panel's roles, candidates, judge, verification and cost", () => {
    render(<FusionRunDetails summary={summary()} />)
    const details = screen.getByTestId("router-fusion-fusion-details")
    expect(details).toHaveTextContent("Succeeded")
    expect(details).toHaveTextContent("Panel: independent answers compared by a judge")
    expect(details).toHaveTextContent("panel_review")
    expect(details).toHaveTextContent("R1_explicit_mode")
    expect(details).toHaveTextContent("Panel member A")
    expect(details).toHaveTextContent("openai::gpt-5-mini")
    expect(details).toHaveTextContent("Panel member C")
    // A role this build has no label for keeps its own name.
    expect(details).toHaveTextContent("scout")
    expect(details).toHaveTextContent("2 answers, 1 rejected, 0 with invalid evidence")
    expect(details).toHaveTextContent("3 claims supported, 1 rejected, 1 without evidence")
    expect(details).toHaveTextContent("2 contradictions, 1 unresolved")
    expect(details).toHaveTextContent("Passed (model review)")
    expect(details).toHaveTextContent("Accepted")
    expect(details).toHaveTextContent("$0.0910 of $2.0000")
    expect(details).not.toHaveTextContent("1 claims")
    expect(details).toHaveTextContent("(actual)")
    expect(details).toHaveTextContent("rf-run-9")
    expect(details).not.toHaveTextContent("Escalated")
    expect(details).not.toHaveTextContent("Context compactions")
  })

  it("lists the phases in order, naming the ones it knows and keeping the rest", () => {
    render(<FusionRunDetails summary={summary()} />)
    const items = within(screen.getByTestId("router-fusion-timeline")).getAllByRole("listitem")
    expect(items.map((item) => item.textContent)).toEqual([
      "Prepared",
      "Collecting panel answers",
      "Judge reported",
      "Writing the answer",
      "later_phase · new_step",
    ])
  })

  it("explains a cascade's escalation, a degraded answer, unknown calls and a failed run", () => {
    render(
      <FusionRunDetails
        summary={summary({
          mode: "cascade",
          actionId: "cascade_schema",
          ruleId: null,
          status: "failed",
          qualityStatus: "degraded",
          roles: { cheap: "a::b", strong: "c::d" },
          costStatus: "pending",
          errorCode: "VERIFICATION_FAILED",
          timeline: {
            phases: [],
            calls: { started: 3, finished: 3, unknown: 1 },
            candidates: { members: null, rejected: 0, evidenceRejected: 0 },
            judge: null,
            escalated: { reason: "FORMAT_INVALID" },
            degraded: { reason: "SOMETHING_NEW" },
            verification: null,
            compactions: 2,
          },
        })}
      />
    )
    const details = screen.getByTestId("router-fusion-fusion-details")
    expect(details).toHaveTextContent("Failed")
    expect(details).toHaveTextContent("The answer failed verification.")
    expect(details).toHaveTextContent("Cascade: a cheap draft, escalated if it fails verification")
    expect(details).toHaveTextContent("Baseline (no rule matched)")
    expect(details).toHaveTextContent("Cheap draft")
    expect(details).toHaveTextContent("The draft was not in the required format")
    expect(details).toHaveTextContent("SOMETHING_NEW")
    expect(details).toHaveTextContent("Degraded: fewer checks than the action asks for")
    expect(details).toHaveTextContent("pending — a call is still unanswered")
    expect(details).toHaveTextContent("1 with an unknown outcome")
    expect(details).toHaveTextContent("Context compactions2")
    expect(details).not.toHaveTextContent("Candidates")
    expect(details).not.toHaveTextContent("Judge")
    expect(screen.queryByTestId("router-fusion-timeline")).toBeNull()
  })

  it("counts one of a thing in the singular", () => {
    const base = summary()
    render(
      <FusionRunDetails
        summary={{
          ...base,
          timeline: {
            ...base.timeline,
            candidates: { members: 1, rejected: 0, evidenceRejected: 0 },
            judge: { supported: 1, rejected: 0, unverified: 0, contradictions: 1, unresolved: 0 },
          },
        }}
      />
    )
    const details = screen.getByTestId("router-fusion-fusion-details")
    expect(details).toHaveTextContent("1 answer, 0 rejected")
    expect(details).toHaveTextContent("1 claim supported")
    expect(details).toHaveTextContent("1 contradiction, 0 unresolved")
  })

  it("names a status and an error code this build has no words for", () => {
    render(
      <FusionRunDetails
        summary={summary({ status: "paused_somehow", errorCode: "FROM_A_NEWER_HOST" })}
      />
    )
    const details = screen.getByTestId("router-fusion-fusion-details")
    expect(details).toHaveTextContent("paused_somehow")
    expect(details).toHaveTextContent("Refused with code FROM_A_NEWER_HOST.")
  })
})
