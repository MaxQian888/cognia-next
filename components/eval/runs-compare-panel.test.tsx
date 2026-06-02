/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { EvalRunRow } from "@/lib/db/eval-runs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let runs: EvalRunRow[] = []
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useRecentRuns: () => runs,
}))
jest.mock("./run-comparison-view", () => ({
  RunComparisonView: () => <div data-testid="run-comparison-view" />,
}))

import { RunsComparePanel } from "./runs-compare-panel"

describe("RunsComparePanel", () => {
  it("shows the empty state when there are no runs", () => {
    runs = []
    render(<RunsComparePanel />)
    expect(screen.getByText("runs.empty")).toBeInTheDocument()
  })

  it("renders the comparison view when runs exist", () => {
    runs = [{ runId: "r1", targetLabel: "A", passAt1: 1 } as EvalRunRow]
    render(<RunsComparePanel />)
    expect(screen.getByTestId("run-comparison-view")).toBeInTheDocument()
  })
})
