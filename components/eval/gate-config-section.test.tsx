/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/lib/db/eval-datasets", () => ({ updateDataset: jest.fn(async () => undefined) }))

import { updateDataset } from "@/lib/db/eval-datasets"
import { GateConfigSection } from "./gate-config-section"

beforeEach(() => {
  ;(updateDataset as jest.Mock).mockClear()
})

describe("GateConfigSection", () => {
  it("saves entered thresholds and omits empty fields", async () => {
    render(<GateConfigSection datasetId="d1" gate={{ minPassAt1: 0.5 }} />)
    const passAt1 = screen.getByLabelText("fields.minPassAt1")
    fireEvent.change(passAt1, { target: { value: "0.8" } })
    fireEvent.click(screen.getByText("save"))
    await waitFor(() =>
      expect(updateDataset).toHaveBeenCalledWith("d1", { gate: { minPassAt1: 0.8 } })
    )
    expect(await screen.findByRole("status")).toBeInTheDocument()
  })

  it("clears the gate when all fields are emptied", async () => {
    render(<GateConfigSection datasetId="d1" gate={{ minPassAt1: 0.5 }} />)
    fireEvent.change(screen.getByLabelText("fields.minPassAt1"), { target: { value: "" } })
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(updateDataset).toHaveBeenCalledWith("d1", { gate: undefined }))
  })

  it("prefills existing thresholds incl. a numeric scorer floor and cost cap", () => {
    render(
      <GateConfigSection
        datasetId="d1"
        gate={{ minPassHatK: 0.7, minScorerPassRate: 0.6, maxTotalCostUsd: 2 }}
      />
    )
    expect(screen.getByLabelText("fields.minPassHatK")).toHaveValue(0.7)
    expect(screen.getByLabelText("fields.minScorerPassRate")).toHaveValue(0.6)
    expect(screen.getByLabelText("fields.maxTotalCostUsd")).toHaveValue(2)
  })

  it("ignores non-numeric input on save", async () => {
    render(<GateConfigSection datasetId="d1" />)
    fireEvent.change(screen.getByLabelText("fields.maxTotalCostUsd"), {
      target: { value: "abc" },
    })
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(updateDataset).toHaveBeenCalledWith("d1", { gate: undefined }))
  })
})
