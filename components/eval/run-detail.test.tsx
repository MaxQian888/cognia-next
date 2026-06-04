/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalRunCaseResults: jest.fn(() => [
    {
      id: "r1::c1",
      runId: "r1",
      caseId: "c1",
      scores: { assertion: { value: 1, passed: true } },
      passAt1: true,
    },
    {
      id: "r1::c2",
      runId: "r1",
      caseId: "c2",
      scores: { assertion: { value: 0, passed: false }, cost: { value: 0.5, passed: true } },
      passAt1: false,
    },
  ]),
  useEvalCases: jest.fn(() => [
    { id: "c1", input: "first prompt" },
    { id: "c2", input: "second prompt" },
  ]),
}))
jest.mock("@/lib/db/eval-runs", () => ({
  getRun: jest.fn(async () => ({
    runId: "r1",
    datasetId: "d1",
    datasetVersion: 1,
    targetLabel: "opus",
    k: 1,
    caseCount: 2,
    scorers: {},
    passAt1: 0.5,
    passHatK: 0.5,
    totalCostUsd: 0.12,
    avgLatencyMs: 800,
    createdAt: 1717400000000,
  })),
}))

import { useEvalRunCaseResults } from "@/hooks/eval/use-eval-data"
import { RunDetail } from "./run-detail"

describe("RunDetail", () => {
  it("renders the report header, failing gate verdict with reasons, and per-case table", async () => {
    render(<RunDetail runId="r1" gate={{ minPassAt1: 0.9 }} onBack={jest.fn()} />)
    expect(await screen.findByText("opus")).toBeInTheDocument()
    expect(screen.getByText("gateFailed")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(/passAt1 0\.500 < 0\.9/)
    expect(screen.getByText("first prompt")).toBeInTheDocument()
    expect(screen.getByText("second prompt")).toBeInTheDocument()
    // scorer columns are the union of seen scorer ids, sorted
    expect(screen.getByText("assertion")).toBeInTheDocument()
    expect(screen.getByText("cost")).toBeInTheDocument()
    // c1 has no "cost" score → dash cell
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.getByText("pass")).toBeInTheDocument()
    expect(screen.getByText("fail")).toBeInTheDocument()
  })

  it("shows a passing gate badge and falls back to caseId for unknown cases", async () => {
    // Persistent (not Once): the hook re-runs on the post-getRun re-render.
    ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([
      { id: "r1::cX", runId: "r1", caseId: "cX", scores: {}, passAt1: true },
    ])
    render(<RunDetail runId="r1" gate={{ minPassAt1: 0.1 }} onBack={jest.fn()} />)
    expect(await screen.findByText("gatePassed")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("cX")).toBeInTheDocument() // no input → caseId label
  })

  it("calls onBack and renders without a gate", async () => {
    const onBack = jest.fn()
    render(<RunDetail runId="r1" onBack={onBack} />)
    expect(await screen.findByText("opus")).toBeInTheDocument()
    expect(screen.queryByText("gateFailed")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("back"))
    expect(onBack).toHaveBeenCalled()
  })

  it("renders the no-cases state", async () => {
    ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([])
    render(<RunDetail runId="r1" onBack={jest.fn()} />)
    expect(await screen.findByText("noCases")).toBeInTheDocument()
  })
})
