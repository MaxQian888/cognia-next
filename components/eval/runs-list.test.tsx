/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalRuns: jest.fn(() => [
    {
      runId: "r1",
      datasetId: "d1",
      datasetVersion: 1,
      targetLabel: "opus",
      k: 2,
      caseCount: 10,
      scorers: {},
      passAt1: 0.9,
      passHatK: 0.8,
      totalCostUsd: 0.5,
      avgLatencyMs: 100,
      createdAt: 1717400000000,
    },
  ]),
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

  it("renders the empty state", () => {
    ;(useEvalRuns as jest.Mock).mockReturnValueOnce([])
    render(<RunsList datasetId="d1" onOpenRun={jest.fn()} />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })
})
