/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SreTimelineRow, SreValidationResult } from "../evidence"
import { applyTimeline, applyValidation, createIncident, type SreIncident } from "../incident/model"
import { groupIssues, TimelineTable } from "./timeline-table"
import { registerSreBundle, unregisterSreBundle } from "../i18n.test-helpers"

beforeEach(() => registerSreBundle())
afterEach(() => unregisterSreBundle())

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

  it("renders the validator's code verbatim with a translated explanation", () => {
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
    // The bundle's sentence, never the validator's English `message`.
    expect(issue).toHaveTextContent("Metrics alone cannot establish a request event.")
    expect(issue).not.toHaveTextContent("metrics cannot establish a request event")
  })

  it("interpolates the issue's own values into the translation", () => {
    const failed: SreValidationResult = {
      ok: false,
      issues: [
        {
          code: "row.claim_unsupported",
          message: "provider value ...",
          rowIndex: 0,
          params: { kind: "provider", value: "qwen-vllm-z" },
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
    expect(screen.getByTestId("sre-timeline-issue")).toHaveTextContent(
      "The provider value “qwen-vllm-z” does not appear in the cited evidence."
    )
  })

  it("falls back to a generic sentence for a code the bundle does not know", () => {
    const failed: SreValidationResult = {
      ok: false,
      issues: [{ code: "row.future_rule", message: "x", rowIndex: 0 }],
      evidenceCount: 1,
    }
    render(
      <TimelineTable
        incident={applyValidation(applyTimeline(base(), { rows: ROWS }, "n"), failed, "n")}
        validating={false}
        onValidate={jest.fn()}
      />
    )
    expect(screen.getByTestId("sre-timeline-issue")).toHaveTextContent(
      "Unrecognised validation problem (row.future_rule)."
    )
  })

  it("expands a row to its full text, signals, notes and evidence", async () => {
    const rows: SreTimelineRow[] = [
      { ...ROWS[0], signals: ["retry", "timeout"], notes: "second attempt succeeded" },
    ]
    render(
      <TimelineTable
        incident={applyTimeline(base(), { rows }, "n")}
        validating={false}
        onValidate={jest.fn()}
      />
    )
    const toggle = screen.getByTestId("sre-timeline-row-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("sre-timeline-row-details")).not.toBeInTheDocument()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const details = screen.getByTestId("sre-timeline-row-details")
    expect(details).toHaveTextContent("retry · timeout")
    expect(details).toHaveTextContent("second attempt succeeded")
    expect(details).toHaveTextContent(rows[0].evidenceIds.join(" "))
    await userEvent.click(toggle)
    expect(screen.queryByTestId("sre-timeline-row-details")).not.toBeInTheDocument()
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
    expect(screen.getByTestId("sre-timeline-general-issue")).toHaveTextContent(
      "A finding cites evidence that was never fetched: log_9"
    )
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
