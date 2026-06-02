/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
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
  it("renders header + embeds the case list", () => {
    render(<DatasetDetail dataset={dataset} appSettings={null} />)
    expect(screen.getByText("My Set")).toBeInTheDocument()
    expect(screen.getByTestId("case-list")).toBeInTheDocument()
  })

  it("toggles the import / run / versions panels", () => {
    render(<DatasetDetail dataset={dataset} appSettings={null} />)
    fireEvent.click(screen.getByText("detail.import"))
    expect(screen.getByTestId("import-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByText("detail.run"))
    expect(screen.getByTestId("run-config-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByText("detail.versions"))
    expect(screen.getByTestId("version-history")).toBeInTheDocument()
  })

  it("toggles a panel off on second click and accepts runOptions", () => {
    render(
      <DatasetDetail
        dataset={dataset}
        appSettings={null}
        runOptions={{ models: ["m1"], teams: [{ id: "t", name: "T" }] }}
      />
    )
    fireEvent.click(screen.getByText("detail.import"))
    expect(screen.getByTestId("import-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByText("detail.import"))
    expect(screen.queryByTestId("import-dialog")).not.toBeInTheDocument()
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
