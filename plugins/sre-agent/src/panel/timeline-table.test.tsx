/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import type { SreTimelineRow, SreValidationResult } from "../evidence"
import { applyTimeline, applyValidation, createIncident, type SreIncident } from "../incident/model"
import { groupIssues, TimelineTable } from "./timeline-table"

const ROWS: SreTimelineRow[] = [
  {
    time: "12:02:09",
    component: "gateway",
    event: "request accepted",
    signals: [],
    evidenceIds: ["log_001"],
    sources: ["logs"],
    confidence: 0.95,
    flags: [],
  },
  {
    time: "12:02:54",
    component: "provider",
    event: "provider timeout",
    signals: [],
    evidenceIds: ["log_003", "span_002"],
    sources: ["logs", "trace"],
    confidence: 0.9,
    flags: ["timeout"],
  },
]

function base(): SreIncident {
  return createIncident({
    id: "inc",
    now: "n",
    title: "t",
    environment: "prod",
    window: { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" },
  })
}

describe("groupIssues", () => {
  it("keeps row-less issues instead of dropping them", () => {
    const { byRow, general } = groupIssues([
      { code: "row.evidence_unknown", message: "a", rowIndex: 1 },
      { code: "row.claim_unsupported", message: "b", rowIndex: 1 },
      { code: "finding.evidence_unknown", message: "c", evidenceId: "log_9" },
    ])
    expect(byRow.get(1)).toHaveLength(2)
    expect(general.map((issue) => issue.code)).toEqual(["finding.evidence_unknown"])
  })
})

describe("TimelineTable", () => {
  it("explains the empty state and cannot be validated", () => {
    render(<TimelineTable incident={base()} validating={false} onValidate={jest.fn()} />)
    expect(screen.getByTestId("sre-timeline-empty")).toBeInTheDocument()
    expect(screen.getByTestId("sre-timeline-validate")).toBeDisabled()
  })

  it("says the draft is unchecked rather than showing it as passing", () => {
    render(
      <TimelineTable
        incident={applyTimeline(base(), { rows: ROWS }, "n")}
        validating={false}
        onValidate={jest.fn()}
      />
    )
    expect(screen.getByTestId("sre-timeline-verdict")).toHaveTextContent("Not checked yet")
    expect(screen.getAllByTestId("sre-timeline-row")).toHaveLength(2)
  })

  it("renders the validator's code verbatim on the row it belongs to", () => {
    const failed: SreValidationResult = {
      ok: false,
      issues: [
        {
          code: "row.metrics_only_event",
          message: "metrics cannot establish a request event",
          rowIndex: 1,
        },
      ],
      evidenceCount: 4,
    }
    render(
      <TimelineTable
        incident={applyValidation(applyTimeline(base(), { rows: ROWS }, "n"), failed, "n")}
        validating={false}
        onValidate={jest.fn()}
      />
    )
    expect(screen.getByTestId("sre-timeline-verdict")).toHaveTextContent("1 problems")
    const issue = screen.getByTestId("sre-timeline-issue")
    expect(issue).toHaveTextContent("row.metrics_only_event")
    expect(issue).toHaveTextContent("metrics cannot establish a request event")
  })

  it("surfaces issues that name no row under their own heading", () => {
    const failed: SreValidationResult = {
      ok: false,
      issues: [
        { code: "finding.evidence_unknown", message: "finding cites unknown", evidenceId: "log_9" },
      ],
      evidenceCount: 4,
    }
    render(
      <TimelineTable
        incident={applyValidation(applyTimeline(base(), { rows: ROWS }, "n"), failed, "n")}
        validating={false}
        onValidate={jest.fn()}
      />
    )
    expect(screen.getByText("Problems with the draft as a whole")).toBeInTheDocument()
    expect(screen.getByTestId("sre-timeline-general-issue")).toHaveTextContent("(log_9)")
    expect(screen.queryByTestId("sre-timeline-issue")).not.toBeInTheDocument()
  })

  it("reports a clean verdict and runs the check on demand", async () => {
    const onValidate = jest.fn()
    const passed: SreValidationResult = { ok: true, issues: [], evidenceCount: 4 }
    render(
      <TimelineTable
        incident={applyValidation(applyTimeline(base(), { rows: ROWS }, "n"), passed, "n")}
        validating={false}
        onValidate={onValidate}
      />
    )
    expect(screen.getByTestId("sre-timeline-verdict")).toHaveTextContent(
      "Every row cites evidence that exists"
    )
    await userEvent.click(screen.getByTestId("sre-timeline-validate"))
    expect(onValidate).toHaveBeenCalledTimes(1)
  })

  it("locks the check while one is in flight", () => {
    render(
      <TimelineTable
        incident={applyTimeline(base(), { rows: ROWS }, "n")}
        validating
        onValidate={jest.fn()}
      />
    )
    expect(screen.getByTestId("sre-timeline-validate")).toBeDisabled()
  })
})
