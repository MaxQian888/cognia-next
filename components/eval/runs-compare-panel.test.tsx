/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { EvalRunRow } from "@/lib/db/eval-runs"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let runs: EvalRunRow[] = []
let cases: { id: string; input: string }[] = []
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useRecentRuns: () => runs,
  useEvalCases: () => cases,
}))
const comparisonProps = jest.fn()
jest.mock("./run-comparison-view", () => ({
  RunComparisonView: (props: unknown) => {
    comparisonProps(props)
    return <div data-testid="run-comparison-view" />
  },
}))

import { RunsComparePanel } from "./runs-compare-panel"

describe("RunsComparePanel", () => {
  it("shows the empty state when there are no runs", () => {
    runs = []
    cases = []
    render(<RunsComparePanel />)
    expect(screen.getByText("runs.empty")).toBeInTheDocument()
  })

  it("renders the comparison view when runs exist", () => {
    runs = [{ runId: "r1", targetLabel: "A", passAt1: 1 } as EvalRunRow]
    render(<RunsComparePanel />)
    expect(screen.getByTestId("run-comparison-view")).toBeInTheDocument()
  })

  it("labels the grid rows with case inputs instead of raw ids", () => {
    // `inputsByCase` existed on RunComparisonView but only a Storybook story
    // ever passed it, so every row read as `evc_imp_…`.
    runs = [{ runId: "r1", datasetId: "d1", targetLabel: "A", passAt1: 1 } as EvalRunRow]
    cases = [
      { id: "c1", input: "first prompt" },
      { id: "c2", input: "second prompt" },
    ]
    comparisonProps.mockClear()
    render(<RunsComparePanel />)
    expect(comparisonProps).toHaveBeenCalledWith(
      expect.objectContaining({
        inputsByCase: { c1: "first prompt", c2: "second prompt" },
      })
    )
  })
})
