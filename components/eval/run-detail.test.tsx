/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

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
      scores: { assertion: { value: 1, passed: true, status: "scored" } },
      verdict: "pass",
      passAt1: true,
    },
    {
      id: "r1::c2",
      runId: "r1",
      caseId: "c2",
      scores: {
        assertion: { value: 0, passed: false, status: "scored" },
        cost: { value: 0.5, passed: true, status: "scored" },
      },
      verdict: "fail",
      passAt1: false,
    },
  ]),
  useEvalCases: jest.fn(() => [
    { id: "c1", input: "first prompt" },
    { id: "c2", input: "second prompt" },
  ]),
}))
jest.mock("@/lib/db/eval-runs", () => ({
  getRun: jest.fn(),
}))
const upsertCalibrationItem = jest.fn<Promise<unknown>, [Record<string, unknown>]>(async () => ({}))
jest.mock("@/lib/db/calibration-items", () => ({
  upsertCalibrationItem: (...a: unknown[]) => upsertCalibrationItem(...(a as [])),
}))

import { useEvalRunCaseResults } from "@/hooks/eval/use-eval-data"
import { getRun } from "@/lib/db/eval-runs"
import { RunDetail } from "./run-detail"

/**
 * jsdom applies no CSS, so the `md:hidden` card list and the `hidden md:block`
 * table BOTH render. Scope row assertions to one of them.
 */
const table = () => within(screen.getByRole("table"))
const cards = () => within(screen.getByTestId("run-detail-cards"))

const RUN = {
  runId: "r1",
  datasetId: "d1",
  datasetVersion: 1,
  targetLabel: "opus",
  k: 1,
  caseCount: 2,
  gradedCaseCount: 2,
  ungradedCaseCount: 0,
  scorers: {},
  passAt1: 0.5,
  passHatK: 0.5,
  totalCostUsd: 0.12,
  avgLatencyMs: 800,
  createdAt: 1717400000000,
  scoringVersion: 2 as const,
}

function agg(scorerId: string, over: Record<string, number> = {}) {
  return {
    scorerId,
    dimension: "response-quality" as const,
    meanValue: 0,
    passRate: 0,
    scoredCount: 0,
    notApplicableCount: 0,
    erroredCount: 0,
    measurementCount: 0,
    observations: 2,
    ...over,
  }
}

beforeEach(() => {
  ;(getRun as jest.Mock).mockResolvedValue(RUN)
})

describe("RunDetail", () => {
  it("renders the report header, failing gate verdict with reasons, and per-case table", async () => {
    render(<RunDetail runId="r1" gate={{ minPassAt1: 0.9 }} onBack={jest.fn()} />)
    expect(await screen.findByText("opus")).toBeInTheDocument()
    expect(screen.getByText("gateFailed")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(/passAt1 0\.500 < 0\.9/)
    expect(table().getByText("first prompt")).toBeInTheDocument()
    expect(table().getByText("second prompt")).toBeInTheDocument()
    // scorer columns are the union of seen scorer ids, sorted
    expect(table().getByText("assertion")).toBeInTheDocument()
    expect(table().getByText("cost")).toBeInTheDocument()
    // c1 has no "cost" score → dash cell
    expect(table().getByText("—")).toBeInTheDocument()
    expect(table().getByText("pass")).toBeInTheDocument()
    expect(table().getByText("fail")).toBeInTheDocument()
    expect(screen.getByTestId("graded-count")).toHaveTextContent('{"graded":2,"ungraded":0}')
  })

  it("shows a passing gate badge and falls back to caseId for unknown cases", async () => {
    // Persistent (not Once): the hook re-runs on the post-getRun re-render.
    ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([
      { id: "r1::cX", runId: "r1", caseId: "cX", scores: {}, verdict: "pass", passAt1: true },
    ])
    render(<RunDetail runId="r1" gate={{ minPassAt1: 0.1 }} onBack={jest.fn()} />)
    expect(await screen.findByText("gatePassed")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(table().getByText("cX")).toBeInTheDocument() // no input → caseId label
  })

  it("renders an ungraded row as neutral rather than as a failure", async () => {
    ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([
      {
        id: "r1::c9",
        runId: "r1",
        caseId: "c9",
        scores: {
          assertion: { value: 0, passed: false, status: "not-applicable" },
          cost: { value: 1, passed: false, status: "measurement" },
        },
        verdict: "ungraded",
        passAt1: false,
      },
    ])
    render(<RunDetail runId="r1" onBack={jest.fn()} />)
    await screen.findByRole("table")
    expect(table().getByText("ungraded")).toBeInTheDocument()
    // Neither non-verdict cell renders a red 0.00 that reads as "model wrong".
    expect(table().queryByText("0.00")).not.toBeInTheDocument()
    expect(table().queryByText("fail")).not.toBeInTheDocument()
  })

  it("raises an alert when a scorer failed on every case", async () => {
    ;(getRun as jest.Mock).mockResolvedValue({
      ...RUN,
      scorers: { "judge-task-completion": agg("judge-task-completion", { erroredCount: 2 }) },
    })
    render(<RunDetail runId="r1" onBack={jest.fn()} />)
    expect(await screen.findByTestId("scorer-error-alert")).toHaveTextContent(
      "judge-task-completion"
    )
  })

  it("shows the ungraded hint and count when cases went unjudged", async () => {
    ;(getRun as jest.Mock).mockResolvedValue({
      ...RUN,
      caseCount: 5,
      gradedCaseCount: 2,
      ungradedCaseCount: 3,
    })
    render(<RunDetail runId="r1" onBack={jest.fn()} />)
    expect(await screen.findByTestId("ungraded-hint")).toHaveTextContent('{"count":3}')
    expect(screen.getByTestId("graded-count")).toHaveTextContent('{"graded":2,"ungraded":3}')
  })

  it("badges a legacy run, hides the graded counts, and withholds its gate verdict", async () => {
    const { scoringVersion: _drop, ...legacy } = RUN
    ;(getRun as jest.Mock).mockResolvedValue(legacy)
    render(<RunDetail runId="r1" gate={{ minPassAt1: 0.1 }} onBack={jest.fn()} />)
    expect(await screen.findByTestId("legacy-scoring")).toBeInTheDocument()
    expect(screen.queryByTestId("graded-count")).not.toBeInTheDocument()
    expect(screen.queryByText("gatePassed")).not.toBeInTheDocument()
    expect(screen.queryByText("gateFailed")).not.toBeInTheDocument()
  })

  it("expands a case to the agent's answer and each judge's reasoning", async () => {
    // A failing case used to be a dead end: a score and a red cell, with no way
    // to see what the model said or why the judge rejected it.
    ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([
      {
        id: "r1::c1",
        runId: "r1",
        caseId: "c1",
        scores: {
          "judge-task-completion": {
            value: 0,
            passed: false,
            status: "scored",
            reasoning: "the answer never states a total",
          },
        },
        verdict: "fail",
        passAt1: false,
        output: "I am not sure how to work this out.",
      },
    ])
    render(<RunDetail runId="r1" onBack={jest.fn()} />)
    await screen.findByRole("table")
    expect(table().getByTestId("case-detail")).toBeInTheDocument()
    expect(table().getByTestId("case-output")).toHaveTextContent(
      "I am not sure how to work this out."
    )
    expect(table().getByText("the answer never states a total")).toBeInTheDocument()
    // …and the narrow-screen card list carries the same detail.
    expect(cards().getByTestId("case-output")).toBeInTheDocument()
  })

  it("marks a truncated answer and surfaces a failed run", async () => {
    ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([
      {
        id: "r1::c1",
        runId: "r1",
        caseId: "c1",
        scores: {},
        verdict: "ungraded",
        passAt1: false,
        output: "cut short",
        outputTruncated: true,
        sampleError: "sidecar unavailable",
      },
    ])
    render(<RunDetail runId="r1" onBack={jest.fn()} />)
    await screen.findByRole("table")
    expect(table().getByTestId("case-output")).toHaveTextContent("outputTruncated")
    expect(table().getAllByRole("alert")[0]).toHaveTextContent("sidecar unavailable")
  })

  it("renders a plain label when a row carries no answer or reasoning", async () => {
    ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([
      {
        id: "r1::c1",
        runId: "r1",
        caseId: "c1",
        scores: { assertion: { value: 1, passed: true, status: "scored" } },
        verdict: "pass",
        passAt1: true,
      },
    ])
    render(<RunDetail runId="r1" onBack={jest.fn()} />)
    await screen.findByRole("table")
    expect(table().getByText("first prompt")).toBeInTheDocument()
    expect(table().queryByTestId("case-detail")).not.toBeInTheDocument()
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

  describe("calibration seeding", () => {
    const judged = [
      {
        id: "r1::c1",
        runId: "r1",
        caseId: "c1",
        scores: {
          "judge-task-completion": {
            value: 1,
            passed: true,
            status: "scored",
            reasoning: "covers every field",
          },
        },
        verdict: "pass",
        passAt1: true,
        output: "the agent's answer",
      },
    ]

    it("stays hidden when the run has no judged cases", async () => {
      ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([
        {
          id: "r1::c1",
          runId: "r1",
          caseId: "c1",
          scores: {},
          verdict: "ungraded",
          passAt1: false,
        },
      ])
      render(<RunDetail runId="r1" onBack={jest.fn()} />)
      await screen.findByRole("table")
      expect(screen.queryByTestId("seed-calibration-open")).not.toBeInTheDocument()
    })

    it("seeds a set with the judge's verdict as the starting gold label", async () => {
      // Calibration sets could only be built by retyping (request, answer)
      // pairs by hand, so nobody built one and no judge was ever measured.
      ;(useEvalRunCaseResults as jest.Mock).mockReturnValue(judged)
      upsertCalibrationItem.mockClear()
      render(<RunDetail runId="r1" onBack={jest.fn()} />)
      fireEvent.click(await screen.findByTestId("seed-calibration-open"))
      expect(screen.getByTestId("seed-preview")).toHaveTextContent('{"count":1,"skipped":0}')
      fireEvent.change(screen.getByLabelText("calibration.setId"), {
        target: { value: "judge-v1" },
      })
      fireEvent.click(screen.getByText('calibration.seed:{"count":1}'))
      await waitFor(() => expect(upsertCalibrationItem).toHaveBeenCalledTimes(1))
      expect(upsertCalibrationItem.mock.calls[0][0]).toMatchObject({
        setId: "judge-v1",
        input: "first prompt",
        output: "the agent's answer",
        goldLabel: "pass",
        source: "eval-case",
        sourceCaseId: "c1",
        notes: "covers every field",
      })
    })

    it("lets the user pick which judge to calibrate", async () => {
      ;(useEvalRunCaseResults as jest.Mock).mockReturnValue([
        {
          ...judged[0],
          scores: {
            "judge-task-completion": { value: 1, passed: true, status: "scored" },
            "judge-instruction-following": { value: 0, passed: false, status: "scored" },
          },
        },
      ])
      upsertCalibrationItem.mockClear()
      render(<RunDetail runId="r1" onBack={jest.fn()} />)
      fireEvent.click(await screen.findByTestId("seed-calibration-open"))
      fireEvent.change(screen.getByLabelText("calibration.scorer"), {
        target: { value: "judge-task-completion" },
      })
      fireEvent.change(screen.getByLabelText("calibration.setId"), { target: { value: "s" } })
      fireEvent.click(screen.getByText('calibration.seed:{"count":1}'))
      await waitFor(() => expect(upsertCalibrationItem).toHaveBeenCalled())
      expect(upsertCalibrationItem.mock.calls[0][0]).toMatchObject({
        criterion: "judge-task-completion",
        goldLabel: "pass",
      })
    })

    it("will not seed without a set name", async () => {
      ;(useEvalRunCaseResults as jest.Mock).mockReturnValue(judged)
      render(<RunDetail runId="r1" onBack={jest.fn()} />)
      fireEvent.click(await screen.findByTestId("seed-calibration-open"))
      expect(screen.getByText('calibration.seed:{"count":1}')).toBeDisabled()
    })

    it("closes without seeding", async () => {
      ;(useEvalRunCaseResults as jest.Mock).mockReturnValue(judged)
      upsertCalibrationItem.mockClear()
      render(<RunDetail runId="r1" onBack={jest.fn()} />)
      fireEvent.click(await screen.findByTestId("seed-calibration-open"))
      fireEvent.click(screen.getByText("calibration.cancel"))
      expect(screen.queryByTestId("seed-calibration")).not.toBeInTheDocument()
      expect(upsertCalibrationItem).not.toHaveBeenCalled()
    })
  })
})
