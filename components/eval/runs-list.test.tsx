/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))
const RUN = {
  runId: "r1",
  datasetId: "d1",
  datasetVersion: 1,
  targetLabel: "opus",
  k: 2,
  caseCount: 10,
  gradedCaseCount: 10,
  ungradedCaseCount: 0,
  scorers: {},
  passAt1: 0.9,
  passHatK: 0.8,
  totalCostUsd: 0.5,
  avgLatencyMs: 100,
  createdAt: 1717400000000,
  scoringVersion: 2 as const,
}

jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalRuns: jest.fn(() => [RUN]),
}))
import { useEvalRuns } from "@/hooks/eval/use-eval-data"
import { RunsList } from "./runs-list"

describe("RunsList", () => {
  it("lists runs with pass rates and a failing gate badge, and opens a run", () => {
    const onOpen = jest.fn()
    render(<RunsList datasetId="d1" gate={{ minPassAt1: 0.95 }} onOpenRun={onOpen} />)
    expect(screen.getByText("opus")).toBeInTheDocument()
    expect(screen.getByText('passAt1:{"pct":90}')).toBeInTheDocument()
    expect(screen.getByText('passHatK:{"pct":80,"k":2}')).toBeInTheDocument()
    expect(screen.getByText("gateFailed")).toBeInTheDocument() // 0.9 < 0.95
    fireEvent.click(screen.getByLabelText('openRun:{"label":"opus"}'))
    expect(onOpen).toHaveBeenCalledWith("r1")
  })

  it("shows a passing gate badge and no gate badge without thresholds", () => {
    const { rerender } = render(
      <RunsList datasetId="d1" gate={{ minPassAt1: 0.5 }} onOpenRun={jest.fn()} />
    )
    expect(screen.getByText("gatePassed")).toBeInTheDocument()
    rerender(<RunsList datasetId="d1" onOpenRun={jest.fn()} />)
    expect(screen.queryByText("gatePassed")).not.toBeInTheDocument()
    expect(screen.queryByText("gateFailed")).not.toBeInTheDocument()
  })

  it("badges a legacy run and withholds its gate verdict", () => {
    // A run written before the scoring fix carries an inflated passAt1, so a
    // green "gate passed" on it would be a lie.
    const { scoringVersion: _drop, ...legacy } = RUN
    ;(useEvalRuns as jest.Mock).mockReturnValueOnce([legacy])
    render(<RunsList datasetId="d1" gate={{ minPassAt1: 0.5 }} onOpenRun={jest.fn()} />)
    expect(screen.getByTestId("runs-list-legacy")).toBeInTheDocument()
    expect(screen.queryByText("gatePassed")).not.toBeInTheDocument()
    expect(screen.queryByText("gateFailed")).not.toBeInTheDocument()
  })

  it("surfaces the ungraded count when a run left cases unjudged, and hides it otherwise", () => {
    ;(useEvalRuns as jest.Mock).mockReturnValue([
      { ...RUN, gradedCaseCount: 7, ungradedCaseCount: 3 },
    ])
    const { rerender } = render(<RunsList datasetId="d1" onOpenRun={jest.fn()} />)
    expect(screen.getByTestId("runs-list-ungraded")).toHaveTextContent('{"count":3}')
    // Zero ungraded → no badge.
    ;(useEvalRuns as jest.Mock).mockReturnValue([RUN])
    rerender(<RunsList datasetId="d1" onOpenRun={jest.fn()} />)
    expect(screen.queryByTestId("runs-list-ungraded")).not.toBeInTheDocument()
    // A v2 row that somehow never recorded the count → no badge either.
    const { ungradedCaseCount: _drop, ...noCount } = RUN
    ;(useEvalRuns as jest.Mock).mockReturnValue([noCount])
    rerender(<RunsList datasetId="d1" onOpenRun={jest.fn()} />)
    expect(screen.queryByTestId("runs-list-ungraded")).not.toBeInTheDocument()
    ;(useEvalRuns as jest.Mock).mockReturnValue([RUN])
  })

  it("renders the empty state", () => {
    ;(useEvalRuns as jest.Mock).mockReturnValueOnce([])
    render(<RunsList datasetId="d1" onOpenRun={jest.fn()} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
