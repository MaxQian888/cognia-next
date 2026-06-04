/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { EvalDataset } from "@/types/eval/eval"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalCases: () => [
    {
      id: "c1",
      datasetId: "d",
      input: "hi",
      capability: "chat",
      source: "handwritten",
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  useEvalDatasetVersions: () => [],
}))
// Child panels are exercised in their own suites; stub them to keep this focused.
jest.mock("./case-list", () => ({ CaseList: () => <div data-testid="case-list" /> }))
jest.mock("./import-dialog", () => ({ ImportDialog: () => <div data-testid="import-dialog" /> }))
jest.mock("./run-config-dialog", () => ({
  RunConfigDialog: () => <div data-testid="run-config-dialog" />,
}))
jest.mock("./version-history", () => ({
  VersionHistory: () => <div data-testid="version-history" />,
}))
jest.mock("./runs-list", () => ({
  RunsList: ({ onOpenRun }: { onOpenRun: (id: string) => void }) => (
    <button data-testid="runs-list" onClick={() => onOpenRun("r1")} />
  ),
}))
jest.mock("./run-detail", () => ({
  RunDetail: ({ runId, onBack }: { runId: string; onBack: () => void }) => (
    <button data-testid={`run-detail-${runId}`} onClick={onBack} />
  ),
}))
jest.mock("./gate-config-section", () => ({
  GateConfigSection: () => <div data-testid="gate-config-section" />,
}))

const toJsonl = jest.fn(() => "jsonl-content")
const toCsv = jest.fn(() => "csv-content")
jest.mock("@/lib/ai/eval/export", () => ({
  toJsonl: (...a: unknown[]) => toJsonl(...(a as [])),
  toCsv: (...a: unknown[]) => toCsv(...(a as [])),
}))

import { DatasetDetail } from "./dataset-detail"

const dataset: EvalDataset = {
  id: "d",
  name: "My Set",
  capability: "chat.tool-use",
  version: 4,
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  toJsonl.mockClear()
  toCsv.mockClear()
})

describe("DatasetDetail", () => {
  it("renders header + the cases segment by default", () => {
    render(<DatasetDetail dataset={dataset} appSettings={null} />)
    expect(screen.getByText("My Set")).toBeInTheDocument()
    expect(screen.getByTestId("case-list")).toBeInTheDocument()
    expect(screen.queryByText("detail.gateConfigured")).not.toBeInTheDocument()
  })

  it("shows a gate badge when the dataset has thresholds", () => {
    render(<DatasetDetail dataset={{ ...dataset, gate: { minPassAt1: 0.9 } }} appSettings={null} />)
    expect(screen.getByText("detail.gateConfigured")).toBeInTheDocument()
  })

  it("switches between cases, runs and versions segments", () => {
    render(<DatasetDetail dataset={dataset} appSettings={null} />)
    fireEvent.click(screen.getByText("detail.segments.runs"))
    expect(screen.getByTestId("runs-list")).toBeInTheDocument()
    fireEvent.click(screen.getByText("detail.segments.versions"))
    expect(screen.getByTestId("version-history")).toBeInTheDocument()
    fireEvent.click(screen.getByText("detail.segments.cases"))
    expect(screen.getByTestId("case-list")).toBeInTheDocument()
  })

  it("drills into a run from the runs segment and backs out", () => {
    render(<DatasetDetail dataset={dataset} appSettings={null} />)
    fireEvent.click(screen.getByText("detail.segments.runs"))
    fireEvent.click(screen.getByTestId("runs-list")) // stub calls onOpenRun("r1")
    expect(screen.getByTestId("run-detail-r1")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("run-detail-r1")) // stub calls onBack
    expect(screen.getByTestId("runs-list")).toBeInTheDocument()
  })

  it("opens the import, run and gate dialogs", () => {
    render(
      <DatasetDetail
        dataset={dataset}
        appSettings={null}
        runOptions={{ models: ["m1"], teams: [{ id: "t", name: "T" }] }}
      />
    )
    fireEvent.click(screen.getByText("detail.import"))
    expect(screen.getByTestId("import-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByText("detail.run"))
    expect(screen.getByTestId("run-config-dialog")).toBeInTheDocument()
    expect(screen.queryByTestId("import-dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("detail.gate"))
    expect(screen.getByTestId("gate-config-section")).toBeInTheDocument()
  })

  it("closes a dialog via Escape (onOpenChange)", async () => {
    render(<DatasetDetail dataset={dataset} appSettings={null} />)
    fireEvent.click(screen.getByText("detail.import"))
    expect(screen.getByTestId("import-dialog")).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("import-dialog")).not.toBeInTheDocument())
  })

  it("exports JSONL + CSV via a blob download", () => {
    const createObjectURL = jest.fn(() => "blob:x")
    const revokeObjectURL = jest.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    HTMLAnchorElement.prototype.click = jest.fn()
    render(<DatasetDetail dataset={dataset} appSettings={null} />)
    fireEvent.click(screen.getByText("detail.exportJsonl"))
    expect(toJsonl).toHaveBeenCalled()
    fireEvent.click(screen.getByText("detail.exportCsv"))
    expect(toCsv).toHaveBeenCalled()
    expect(createObjectURL).toHaveBeenCalled()
  })
})
