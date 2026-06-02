/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { EvalDataset } from "@/types/eval/eval"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${key}:${JSON.stringify(vals)}` : key,
}))

let datasets: EvalDataset[] = []
jest.mock("@/hooks/eval/use-eval-data", () => ({
  useEvalDatasets: () => datasets,
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: { settings: null }) => unknown) => selector({ settings: null }),
}))
const createDataset = jest.fn(async () => ({ id: "new-ds" }))
jest.mock("@/lib/db/eval-datasets", () => ({
  createDataset: (...a: unknown[]) => createDataset(...(a as [])),
}))
// DatasetDetail is covered by its own suite; stub it here.
jest.mock("./dataset-detail", () => ({
  DatasetDetail: ({ dataset }: { dataset: { name: string } }) => (
    <div data-testid="dataset-detail">{dataset.name}</div>
  ),
}))

import { EvalDashboard } from "./eval-dashboard"

function dataset(id: string, name: string, version = 1): EvalDataset {
  return { id, name, capability: "chat.tool-use", version, createdAt: 0, updatedAt: 0 }
}

beforeEach(() => {
  datasets = []
  createDataset.mockClear()
})

describe("EvalDashboard", () => {
  it("shows the empty state when there are no datasets", () => {
    render(<EvalDashboard />)
    expect(screen.getByText("datasets.empty")).toBeInTheDocument()
    expect(screen.getByText("datasets.select")).toBeInTheDocument()
  })

  it("creates a dataset via the form", async () => {
    render(<EvalDashboard />)
    fireEvent.click(screen.getByText("datasets.new"))
    fireEvent.change(screen.getByLabelText("datasets.namePlaceholder"), {
      target: { value: "Set A" },
    })
    fireEvent.change(screen.getByLabelText("datasets.capabilityPlaceholder"), {
      target: { value: "chat" },
    })
    fireEvent.click(screen.getByText("datasets.create"))
    await waitFor(() =>
      expect(createDataset).toHaveBeenCalledWith({ name: "Set A", capability: "chat" })
    )
  })

  it("renders the selected dataset's detail (defaults to the first)", () => {
    datasets = [dataset("d1", "First"), dataset("d2", "Second")]
    render(<EvalDashboard />)
    expect(screen.getByTestId("dataset-detail")).toHaveTextContent("First")
    fireEvent.click(screen.getByText("Second"))
    expect(screen.getByTestId("dataset-detail")).toHaveTextContent("Second")
  })
})
