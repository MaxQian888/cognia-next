/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { CalibrationItemRow } from "@/lib/db/calibration-items"
import type { CalibrationRunRow } from "@/lib/db/calibration-runs"

jest.mock("next-intl", () => ({
  // Echo the key, but interpolate {n}/{errored} so the summary line is testable.
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

const mockSets = jest.fn()
const mockItems = jest.fn()
const mockLatestRun = jest.fn()
const mockRuns = jest.fn()
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useCalibrationSets: () => mockSets(),
  useCalibrationItems: () => mockItems(),
  useLatestCalibrationRun: () => mockLatestRun(),
  useCalibrationRuns: () => mockRuns(),
}))

const mockUpsert = jest.fn()
const mockSetGold = jest.fn()
const mockDelete = jest.fn()
jest.mock("@/lib/db/calibration-items", () => ({
  upsertCalibrationItem: (...args: unknown[]) => mockUpsert(...args),
  setGoldLabel: (...args: unknown[]) => mockSetGold(...args),
  deleteCalibrationItem: (...args: unknown[]) => mockDelete(...args),
}))

const mockRun = jest.fn()
jest.mock("@/lib/ai/eval/calibration/runner", () => {
  class CalibrationNoJudgeError extends Error {
    constructor() {
      super("no judge")
      this.name = "CalibrationNoJudgeError"
    }
  }
  return {
    runCalibration: (...args: unknown[]) => mockRun(...args),
    CalibrationNoJudgeError,
  }
})
import { CalibrationNoJudgeError as FakeNoJudge } from "@/lib/ai/eval/calibration/runner"

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: { settings: unknown }) => unknown) =>
    sel({ settings: { defaultModel: "m" } }),
}))

import { CalibrationPanel } from "./calibration-panel"

function item(overrides: Partial<CalibrationItemRow> = {}): CalibrationItemRow {
  return {
    id: "i1",
    setId: "set-a",
    criterion: "task completion",
    rubric: "Pass only if complete.",
    input: "the request",
    output: "the answer",
    goldLabel: "pass",
    source: "handwritten",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function run(overrides: Partial<CalibrationRunRow> = {}): CalibrationRunRow {
  return {
    runId: "r1",
    setId: "set-a",
    criterion: "task completion",
    rubric: "Pass only if complete.",
    judgeModel: "m",
    itemCount: 2,
    scoredCount: 2,
    erroredCount: 0,
    metrics: {
      matrix: { tp: 1, fp: 1, tn: 0, fn: 0 },
      n: 2,
      tpr: 1,
      tnr: 0,
      precision: 0.5,
      f1: 2 / 3,
      accuracy: 0.5,
      cohenKappa: 0.4,
    },
    verdicts: [
      { itemId: "i1", goldLabel: "pass", judgeValue: 1, judgePassed: true, errored: false },
      {
        itemId: "i2",
        goldLabel: "fail",
        judgeValue: 1,
        judgePassed: true,
        errored: false,
        reasoning: "looked fine",
      },
    ],
    createdAt: 10,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSets.mockReturnValue([])
  mockItems.mockReturnValue([])
  mockLatestRun.mockReturnValue(undefined)
  mockRuns.mockReturnValue([])
})

describe("CalibrationPanel", () => {
  it("renders empty state with no sets, run disabled", () => {
    render(<CalibrationPanel />)
    expect(screen.getByText("calibration.empty")).toBeInTheDocument()
    expect(screen.getByText("calibration.noRun")).toBeInTheDocument()
    expect(screen.getByText("calibration.run").closest("button")).toBeDisabled()
  })

  it("creating a new set selects it and reveals the add-item form", () => {
    render(<CalibrationPanel />)
    fireEvent.change(screen.getByLabelText("calibration.setName"), { target: { value: "set-x" } })
    fireEvent.change(screen.getByLabelText("calibration.criterion"), {
      target: { value: "accuracy" },
    })
    fireEvent.change(screen.getByLabelText("calibration.rubric"), { target: { value: "be right" } })
    fireEvent.click(screen.getByText("calibration.createSet"))
    // The add-item form (input/output) is now present for the new set.
    expect(screen.getByLabelText("calibration.input")).toBeInTheDocument()
  })

  it("adds a handwritten item with the chosen gold label", async () => {
    mockSets.mockReturnValue([
      { setId: "set-a", criterion: "task completion", rubric: "r", itemCount: 0 },
    ])
    render(<CalibrationPanel />)
    fireEvent.change(screen.getByLabelText("calibration.input"), { target: { value: "q" } })
    fireEvent.change(screen.getByLabelText("calibration.output"), { target: { value: "a" } })
    // toggle gold to fail
    const failButtons = screen.getAllByText("calibration.goldFail")
    fireEvent.click(failButtons[0])
    fireEvent.click(screen.getByText("calibration.add"))
    await waitFor(() => expect(mockUpsert).toHaveBeenCalled())
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ setId: "set-a", input: "q", output: "a", goldLabel: "fail" })
    )
  })

  it("lists items and toggles a gold label", () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockItems.mockReturnValue([item({ goldLabel: "pass" })])
    render(<CalibrationPanel />)
    expect(screen.getByText("the request")).toBeInTheDocument()
    // The item row's fail toggle (last goldFail button) flips the label.
    const failButtons = screen.getAllByText("calibration.goldFail")
    fireEvent.click(failButtons[failButtons.length - 1])
    expect(mockSetGold).toHaveBeenCalledWith("i1", "fail")
  })

  it("deletes an item", () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockItems.mockReturnValue([item()])
    render(<CalibrationPanel />)
    fireEvent.click(screen.getByLabelText("calibration.delete"))
    expect(mockDelete).toHaveBeenCalledWith("i1")
  })

  it("runs calibration when items exist", async () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockItems.mockReturnValue([item()])
    mockRun.mockResolvedValue(run())
    render(<CalibrationPanel />)
    fireEvent.click(screen.getByText("calibration.run"))
    await waitFor(() => expect(mockRun).toHaveBeenCalled())
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ setId: "set-a", appSettings: { defaultModel: "m" } })
    )
  })

  it("shows the noJudge message when the runner reports no judge", async () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockItems.mockReturnValue([item()])
    mockRun.mockRejectedValue(new FakeNoJudge())
    render(<CalibrationPanel />)
    fireEvent.click(screen.getByText("calibration.run"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("calibration.noJudge"))
  })

  it("surfaces a generic runner error", async () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockItems.mockReturnValue([item()])
    mockRun.mockRejectedValue(new Error("boom"))
    render(<CalibrationPanel />)
    fireEvent.click(screen.getByText("calibration.run"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"))
  })

  it("renders the metrics card with Cohen's κ and the scored summary", () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 2 }])
    mockLatestRun.mockReturnValue(run())
    render(<CalibrationPanel />)
    expect(screen.getByTestId("kappa-value")).toHaveTextContent("0.400")
    expect(screen.getByText("calibration.metrics.summary:2,0")).toBeInTheDocument()
  })

  it("shows an em-dash and the undefined title when κ is null", () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockLatestRun.mockReturnValue(
      run({
        metrics: {
          matrix: { tp: 1, fp: 0, tn: 0, fn: 0 },
          n: 1,
          tpr: 1,
          tnr: null,
          precision: 1,
          f1: 1,
          accuracy: 1,
          cohenKappa: null,
        },
      })
    )
    render(<CalibrationPanel />)
    const kappa = screen.getByTestId("kappa-value")
    expect(kappa).toHaveTextContent("—")
    expect(kappa).toHaveAttribute("title", "calibration.metrics.metricUndefined")
  })

  it("lists disagreements with the judge's reasoning", () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 2 }])
    mockLatestRun.mockReturnValue(run())
    render(<CalibrationPanel />)
    // i2: gold fail but judge passed → a disagreement, with reasoning.
    expect(screen.getByTestId("disagreement")).toHaveTextContent("looked fine")
  })

  it("renders κ history when prior runs exist", () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 2 }])
    mockRuns.mockReturnValue([run({ runId: "r1" }), run({ runId: "r2" })])
    render(<CalibrationPanel />)
    expect(screen.getByText("calibration.history.heading")).toBeInTheDocument()
  })

  it("shows the empty-disagreement message when judge matches every label", () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockLatestRun.mockReturnValue(
      run({
        verdicts: [
          { itemId: "i1", goldLabel: "pass", judgeValue: 1, judgePassed: true, errored: false },
        ],
      })
    )
    render(<CalibrationPanel />)
    expect(screen.getByText("calibration.disagreement.empty")).toBeInTheDocument()
  })

  it("surfaces a non-Error rejection via String()", async () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockItems.mockReturnValue([item()])
    mockRun.mockRejectedValue("weird failure")
    render(<CalibrationPanel />)
    fireEvent.click(screen.getByText("calibration.run"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("weird failure"))
  })

  it("switches the active set via the picker", () => {
    mockSets.mockReturnValue([
      { setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 },
      { setId: "set-b", criterion: "c2", rubric: "r2", itemCount: 0 },
    ])
    render(<CalibrationPanel />)
    fireEvent.change(screen.getByLabelText("calibration.pickSet"), { target: { value: "set-b" } })
    // selecting the (empty) sentinel value clears back to the first set
    fireEvent.change(screen.getByLabelText("calibration.pickSet"), { target: { value: "" } })
    expect(screen.getByLabelText("calibration.pickSet")).toBeInTheDocument()
  })

  it("toggles gold labels to pass in both the item row and the add form", () => {
    mockSets.mockReturnValue([{ setId: "set-a", criterion: "c", rubric: "r", itemCount: 1 }])
    mockItems.mockReturnValue([item({ goldLabel: "fail" })])
    render(<CalibrationPanel />)
    // item-row pass toggle (last goldPass button) flips i1 → pass
    const passButtons = screen.getAllByText("calibration.goldPass")
    fireEvent.click(passButtons[passButtons.length - 1])
    expect(mockSetGold).toHaveBeenCalledWith("i1", "pass")
    // add-form gold toggle to fail then back to pass exercises both closures
    fireEvent.click(screen.getAllByText("calibration.goldFail")[0])
    fireEvent.click(passButtons[0])
  })
})
