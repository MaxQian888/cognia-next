/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import { ScanHistory } from "./scan-history"
import type { StrixRun } from "../types"

const run = (over: Partial<StrixRun> = {}): StrixRun => ({
  runId: "r1",
  target: "https://x",
  startedAt: 1,
  status: "done",
  findingsCount: 3,
  authorizedAt: 1,
  ...over,
})

describe("ScanHistory", () => {
  it("shows the empty state", () => {
    render(<ScanHistory runs={[]} onView={() => {}} onDelete={() => {}} onClearAll={() => {}} />)
    expect(screen.getByTestId("strix-history-empty")).toBeInTheDocument()
  })

  it("renders rows and fires the row + clear callbacks", () => {
    const onView = jest.fn()
    const onDelete = jest.fn()
    const onClearAll = jest.fn()
    render(
      <ScanHistory runs={[run()]} onView={onView} onDelete={onDelete} onClearAll={onClearAll} />
    )
    expect(screen.getByTestId("strix-history-row")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("strix-clear-all"))
    expect(onClearAll).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId("strix-history-delete"))
    expect(onDelete).toHaveBeenCalledWith("r1")

    fireEvent.click(screen.getByText("View"))
    expect(onView).toHaveBeenCalledWith("r1")
  })
})
