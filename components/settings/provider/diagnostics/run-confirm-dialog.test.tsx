/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { RunConfirmDialog, type RunConfirmDialogProps } from "./run-confirm-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const props: RunConfirmDialogProps = {
  open: true,
  onOpenChange: jest.fn(),
  requestCount: 4,
  estimatedCostUsd: 0.0025,
  unknownCost: false,
  free: true,
  limits: { maxOutputTokens: 256, maxRequestsPerJob: 20, maxEstimatedCostUsd: 1 },
  onConfirm: jest.fn(),
}

describe("RunConfirmDialog", () => {
  beforeEach(() => jest.clearAllMocks())

  it("renders nothing while closed", () => {
    render(<RunConfirmDialog {...props} open={false} />)
    expect(screen.queryByText("confirm.title")).not.toBeInTheDocument()
  })

  it("gates even a free probe, showing the request count", () => {
    render(<RunConfirmDialog {...props} />)
    expect(screen.getByText("confirm.title")).toBeInTheDocument()
    expect(screen.getByText(/"requests":4/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "confirm.runFree" })).toBeInTheDocument()
  })

  it("labels the action as paid when the run costs money", () => {
    render(<RunConfirmDialog {...props} free={false} />)
    expect(screen.getByRole("button", { name: "confirm.runPaid" })).toBeInTheDocument()
  })

  it("formats the estimated cost in dollars", () => {
    render(<RunConfirmDialog {...props} />)
    expect(screen.getByText(/\$0\.002500/)).toBeInTheDocument()
  })

  it("says the cost is unknown rather than implying it is zero", () => {
    render(<RunConfirmDialog {...props} unknownCost estimatedCostUsd={0} />)
    expect(screen.getByText(/confirm\.unknownCost/)).toBeInTheDocument()
    expect(screen.queryByText(/\$0\.000000/)).not.toBeInTheDocument()
  })

  it("shows the hard ceilings the job runs under", () => {
    render(<RunConfirmDialog {...props} />)
    expect(screen.getByText(/"tokens":256.*"requests":20.*"budget":1/)).toBeInTheDocument()
  })

  it("confirms through the parent", () => {
    render(<RunConfirmDialog {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "confirm.runFree" }))
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })
})
