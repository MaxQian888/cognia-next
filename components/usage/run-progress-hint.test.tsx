/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import type { UseRunEstimateResult } from "@/hooks/usage/use-run-estimate"
import type { RunEstimate } from "@/lib/usage/run-estimate/estimate"

jest.mock("@/hooks/usage/use-run-estimate", () => ({ useRunEstimate: jest.fn() }))

import { useRunEstimate } from "@/hooks/usage/use-run-estimate"
import { RunProgressHint } from "./run-progress-hint"

const estimate: RunEstimate = {
  confidence: "based",
  sampleCount: 22,
  tokens: { p10: 100, p50: 1000, p90: 5000 },
  costUsd: { p10: 0.5, p50: 2, p90: 6 },
  durationMs: null,
  stoppedShare: null,
}
const queries = [{ surface: "goal" as const }]
const spend = { costUsd: 1.2, tokens: 400 }

beforeEach(() => {
  jest
    .mocked(useRunEstimate)
    .mockReset()
    .mockReturnValue({ status: "ready", estimate, dormant: false })
})

it("stays hidden until spend and a comparable estimate are available", () => {
  const states: UseRunEstimateResult[] = [
    ...(["idle", "loading", "error"] as const).map((status) => ({
      status,
      estimate: null,
      dormant: false,
    })),
    { status: "ready", estimate: null, dormant: true },
    { status: "ready", estimate: { ...estimate, confidence: "none" }, dormant: false },
  ]
  for (const state of states) {
    jest.mocked(useRunEstimate).mockReturnValue(state)
    const { container, unmount } = render(<RunProgressHint queries={queries} spend={spend} />)
    expect(container).toBeEmptyDOMElement()
    unmount()
  }
})

it("keeps estimate reads idle while spend is unknown", () => {
  const { container } = render(<RunProgressHint queries={queries} spend={null} />)
  expect(container).toBeEmptyDOMElement()
  expect(useRunEstimate).toHaveBeenLastCalledWith(null)
})

it("renders frozen spend and confidence as an advisory line", () => {
  render(<RunProgressHint queries={queries} spend={spend} className="custom-progress" />)
  const line = screen
    .getByText("$1.20 spent so far, similar runs typically total $2.00")
    .closest("p")
  expect(line).toHaveTextContent("based on 22 similar runs")
  expect(line).toHaveAttribute("data-over-range", "false")
  expect(line).toHaveClass("text-muted-foreground", "custom-progress")
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
  expect(useRunEstimate).toHaveBeenLastCalledWith(queries)
})

it("turns amber only above the usual range when spend updates", () => {
  const { rerender } = render(
    <RunProgressHint queries={queries} spend={{ costUsd: 6, tokens: null }} />
  )
  expect(
    screen.getByText("$6.00 spent so far, similar runs typically total $2.00").closest("p")
  ).toHaveAttribute("data-over-range", "false")
  rerender(<RunProgressHint queries={queries} spend={{ costUsd: 6.01, tokens: null }} />)
  const line = screen
    .getByText("$6.01 spent so far, above the usual range for similar runs (up to $6.00)")
    .closest("p")
  expect(line).toHaveAttribute("data-over-range", "true")
  expect(line).toHaveClass("text-amber-600")
})

it("uses tokens when spend cannot be priced and hides incomparable spend", () => {
  const { rerender, container } = render(
    <RunProgressHint queries={queries} spend={{ costUsd: null, tokens: 6000 }} />
  )
  expect(
    screen.getByText("6.0K tokens so far, above the usual range for similar runs (up to 5.0K)")
  ).toBeInTheDocument()
  rerender(<RunProgressHint queries={queries} spend={{ costUsd: null, tokens: null }} />)
  expect(container).toBeEmptyDOMElement()
})
