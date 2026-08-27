/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import type { SreValidationResult } from "../evidence"
import {
  applyTimeline,
  applyValidation,
  createIncident,
  dismissIncident,
  type SreIncident,
} from "../incident/model"
import { ConclusionCard } from "./conclusion-card"

const ROW = {
  time: "12:02",
  component: "gateway",
  event: "timeout",
  signals: [],
  evidenceIds: ["log_003"],
  sources: ["logs" as const],
  confidence: 0.9,
  flags: [],
}
const PASS: SreValidationResult = { ok: true, issues: [], evidenceCount: 1 }
const FAIL: SreValidationResult = {
  ok: false,
  issues: [{ code: "row.evidence_unknown", message: "unknown" }],
  evidenceCount: 1,
}

function base(): SreIncident {
  return createIncident({
    id: "inc",
    now: "n",
    title: "t",
    environment: "prod",
    window: { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" },
  })
}

describe("ConclusionCard", () => {
  it.each([
    ["Draft a timeline first.", base()],
    ["Check the timeline against its evidence first.", applyTimeline(base(), { rows: [ROW] }, "n")],
    [
      "Fix the validation problems first.",
      applyValidation(applyTimeline(base(), { rows: [ROW] }, "n"), FAIL, "n"),
    ],
    ["This incident is already closed.", dismissIncident(base(), "n")],
  ])("shows the button disabled with the reason: %s", (reason, incident) => {
    render(<ConclusionCard incident={incident} onConclude={jest.fn()} />)
    expect(screen.getByTestId("sre-conclude")).toBeDisabled()
    expect(screen.getByTestId("sre-conclude-blocked")).toHaveTextContent(reason)
  })

  it("enables the button and reports no blocker once the check passes", async () => {
    const onConclude = jest.fn()
    const ready = applyValidation(applyTimeline(base(), { rows: [ROW] }, "n"), PASS, "n")
    render(<ConclusionCard incident={ready} onConclude={onConclude} />)

    expect(screen.queryByTestId("sre-conclude-blocked")).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId("sre-conclude"))
    expect(onConclude).toHaveBeenCalledTimes(1)
  })

  it("lists findings and recommendations with the evidence they cite", () => {
    const drafted = applyTimeline(
      base(),
      {
        rows: [ROW],
        findings: [{ text: "timeout preceded fallback", evidenceIds: ["log_003", "log_004"] }],
        recommendations: [{ text: "check queue depth", evidenceIds: [] }],
      },
      "n"
    )
    render(<ConclusionCard incident={drafted} onConclude={jest.fn()} />)

    expect(screen.getByText(/timeout preceded fallback/)).toBeInTheDocument()
    expect(screen.getByText("log_003 log_004")).toBeInTheDocument()
    expect(screen.getByText(/check queue depth/)).toBeInTheDocument()
  })

  it("says nothing is drafted rather than rendering empty sections", () => {
    render(<ConclusionCard incident={base()} onConclude={jest.fn()} />)
    expect(screen.getAllByText("Nothing drafted yet.")).toHaveLength(2)
  })
})
