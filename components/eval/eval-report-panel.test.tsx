/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import type { EvalReportView } from "@cognia/eval-core"
import { EvalReportPanel } from "./eval-report-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ number: (value: number) => `$${value}` }),
}))

// Only the public report data is needed: no database, account, or execution mocks.
const report = {
  experiment: { manifest: { variants: [{ id: "a", name: "Candidate A" }] } },
  recommendation: { result: { paretoVariantIds: ["a"] } },
  evidence: [],
  cost: { actual: 0.5, estimatedWorstCase: 2, hardCap: 3 },
  providerErrors: [{ taskId: "failed-task", error: "timeout" }],
  cases: [
    {
      sampleId: "sample-a",
      taskId: "task-a",
      variantId: "a",
      repetition: 1,
      case: { id: "case-a", input: "Prompt A" },
      sample: { output: "Answer A" },
      scores: [{ id: "score-a", scorerId: "exact", value: 1, passed: true }],
      status: "passed",
    },
    {
      sampleId: "sample-b",
      taskId: "task-b",
      variantId: "b",
      repetition: 1,
      case: { id: "case-b", input: "Prompt B" },
      sample: { output: "Answer B" },
      scores: [],
      status: "failed",
    },
  ],
} as unknown as EvalReportView

function props() {
  return {
    reportView: report,
    reportVariant: "",
    reportStatus: "",
    onVariantChange: jest.fn(),
    onStatusChange: jest.fn(),
  }
}

it("renders report costs, provider failures and expandable evidence from public data", () => {
  render(<EvalReportPanel {...props()} />)
  expect(screen.getByText("$0.5")).toBeInTheDocument()
  expect(screen.getByText("$2")).toBeInTheDocument()
  expect(screen.getByText("$3")).toBeInTheDocument()
  expect(screen.getByText("lab.review.providerErrors")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: /case-a/ }))
  expect(screen.getByText("Prompt A")).toBeVisible()
  expect(screen.getByText("Answer A")).toBeVisible()
  expect(screen.getByText("exact: 1.00")).toBeVisible()
})

it("filters evidence and reports filter changes to its owner", () => {
  const handlers = props()
  const { rerender } = render(<EvalReportPanel {...handlers} />)
  fireEvent.change(screen.getByLabelText("lab.review.filterVariant"), { target: { value: "a" } })
  expect(handlers.onVariantChange).toHaveBeenCalledWith("a")
  fireEvent.change(screen.getByLabelText("lab.review.filterStatus"), {
    target: { value: "failed" },
  })
  expect(handlers.onStatusChange).toHaveBeenCalledWith("failed")
  rerender(<EvalReportPanel {...handlers} reportVariant="a" reportStatus="passed" />)
  expect(screen.getByRole("button", { name: /case-a/ })).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: /case-b/ })).not.toBeInTheDocument()
  rerender(<EvalReportPanel {...handlers} reportStatus="failed" />)
  expect(screen.queryByRole("button", { name: /case-a/ })).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: /case-b/ })).toBeInTheDocument()
})

it("renders the existing empty state without report data", () => {
  render(<EvalReportPanel {...props()} reportView={null} />)
  expect(screen.getByText("lab.review.awaitingEvidence")).toBeInTheDocument()
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
})
