/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { EvalDataset, EvalReport } from "@/types/eval/eval"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let datasets: EvalDataset[] = []
let runs: EvalReport[] = []
let deterministicOnly = false

jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalDatasets: () => datasets,
  useEvalRuns: () => runs,
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: { settings: null }) => unknown) => selector({ settings: null }),
}))
const createDataset = jest.fn(async () => ({ id: "new-ds" }))
const deleteDataset = jest.fn(async () => {})
jest.mock("@/lib/db/eval-datasets", () => ({
  createDataset: (...a: unknown[]) => createDataset(...(a as [])),
  deleteDataset: (...a: unknown[]) => deleteDataset(...(a as [])),
}))
jest.mock("@/lib/ai/eval/browser-deps", () => ({
  buildBrowserRunDeps: () => ({ deps: {}, deterministicOnly }),
}))
const runDatasetById = jest.fn(async () => ({}) as EvalReport)
jest.mock("@/lib/ai/eval/run-controller", () => ({
  runDatasetById: (...a: unknown[]) => runDatasetById(...(a as [])),
}))

import { EvalDashboard } from "./eval-dashboard"

function dataset(id: string, name: string, version = 1): EvalDataset {
  return { id, name, capability: "chat.tool-use", version, createdAt: 0, updatedAt: 0 }
}
function report(runId: string): EvalReport {
  return {
    runId,
    datasetId: "d1",
    datasetVersion: 1,
    targetLabel: "opus",
    k: 2,
    caseCount: 3,
    scorers: {
      "tool-selection": {
        scorerId: "tool-selection",
        dimension: "tool-use",
        meanValue: 1,
        passRate: 1,
        errorCount: 0,
        observations: 3,
      },
    },
    passAt1: 1,
    passHatK: 0.66,
    totalCostUsd: 0.012,
    avgLatencyMs: 850,
    createdAt: 0,
  }
}

beforeEach(() => {
  datasets = []
  runs = []
  deterministicOnly = false
  createDataset.mockClear()
  deleteDataset.mockClear()
  runDatasetById.mockClear()
})

describe("EvalDashboard", () => {
  it("renders the empty datasets state", () => {
    render(<EvalDashboard />)
    expect(screen.getByText("datasets.empty")).toBeInTheDocument()
  })

  it("renders datasets and the runs for the default-selected dataset", () => {
    datasets = [dataset("d1", "Tool use")]
    runs = [report("r1")]
    render(<EvalDashboard />)
    expect(screen.getByText("Tool use")).toBeInTheDocument()
    expect(screen.getByTestId("eval-run-card")).toBeInTheDocument()
    expect(screen.getByText("opus")).toBeInTheDocument()
  })

  it("creates a dataset through the new-dataset form", async () => {
    render(<EvalDashboard />)
    fireEvent.click(screen.getByText("datasets.new"))
    fireEvent.change(screen.getByLabelText("datasets.namePlaceholder"), {
      target: { value: "My DS" },
    })
    fireEvent.change(screen.getByLabelText("datasets.capabilityPlaceholder"), {
      target: { value: "chat.rag" },
    })
    await act(async () => {
      fireEvent.click(screen.getByText("datasets.create"))
    })
    expect(createDataset).toHaveBeenCalledWith({ name: "My DS", capability: "chat.rag" })
  })

  it("runs an evaluation for the selected dataset", async () => {
    datasets = [dataset("d1", "Tool use")]
    render(<EvalDashboard />)
    await act(async () => {
      fireEvent.click(screen.getByText("runs.run"))
    })
    expect(runDatasetById).toHaveBeenCalledWith("d1", expect.anything())
  })

  it("surfaces a run failure", async () => {
    datasets = [dataset("d1", "Tool use")]
    runDatasetById.mockRejectedValueOnce(new Error("sidecar down"))
    render(<EvalDashboard />)
    await act(async () => {
      fireEvent.click(screen.getByText("runs.run"))
    })
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
  })

  it("shows the deterministic-only notice when no judge client resolves", () => {
    datasets = [dataset("d1", "Tool use")]
    deterministicOnly = true
    render(<EvalDashboard />)
    expect(screen.getByText("runs.deterministicOnly")).toBeInTheDocument()
  })

  it("deletes the selected dataset", () => {
    datasets = [dataset("d1", "Tool use")]
    render(<EvalDashboard />)
    fireEvent.click(screen.getByLabelText("datasets.delete"))
    expect(deleteDataset).toHaveBeenCalledWith("d1")
  })

  it("selects a different dataset when clicked", () => {
    datasets = [dataset("d1", "First"), dataset("d2", "Second")]
    render(<EvalDashboard />)
    fireEvent.click(screen.getByText("Second"))
    // still renders; selecting changes the highlighted item without crashing
    expect(screen.getByText("Second")).toBeInTheDocument()
  })

  it("does not create a dataset when the form is empty", async () => {
    render(<EvalDashboard />)
    fireEvent.click(screen.getByText("datasets.new"))
    await act(async () => {
      fireEvent.click(screen.getByText("datasets.create"))
    })
    expect(createDataset).not.toHaveBeenCalled()
  })

  it("cancels the new-dataset form", () => {
    render(<EvalDashboard />)
    fireEvent.click(screen.getByText("datasets.new"))
    expect(screen.getByTestId("new-dataset-form")).toBeInTheDocument()
    fireEvent.click(screen.getByText("datasets.cancel"))
    expect(screen.queryByTestId("new-dataset-form")).not.toBeInTheDocument()
  })
})
