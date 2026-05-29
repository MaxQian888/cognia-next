/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { AddConnectorGrid } from "./add-connector-grid"
import type { PlatformKind } from "@/types/connectors/platform-kind"

const KINDS: PlatformKind[] = ["telegram", "matrix", "lark"]

function renderGrid(overrides: Partial<React.ComponentProps<typeof AddConnectorGrid>> = {}) {
  const onPick = jest.fn()
  const onOpenChange = jest.fn()
  render(
    <AddConnectorGrid
      open
      onOpenChange={onOpenChange}
      kinds={KINDS}
      configuredCounts={new Map<PlatformKind, number>([["telegram", 2]])}
      onPick={onPick}
      {...overrides}
    />
  )
  return { onPick, onOpenChange }
}

describe("AddConnectorGrid", () => {
  it("renders a card per kind with its brand label", () => {
    renderGrid()
    expect(screen.getByTestId("add-connector-card-telegram")).toBeInTheDocument()
    expect(screen.getByTestId("add-connector-card-matrix")).toBeInTheDocument()
    expect(screen.getByTestId("add-connector-card-lark")).toBeInTheDocument()
    expect(screen.getByText("Telegram")).toBeInTheDocument()
  })

  it("shows the configured-count badge only for kinds with instances", () => {
    renderGrid()
    expect(screen.getByTestId("add-connector-count-telegram")).toHaveTextContent("2")
    expect(screen.queryByTestId("add-connector-count-matrix")).not.toBeInTheDocument()
  })

  it("filters cards by the search query", async () => {
    renderGrid()
    fireEvent.change(screen.getByTestId("add-connector-search"), { target: { value: "matrix" } })
    await waitFor(() => {
      expect(screen.getByTestId("add-connector-card-matrix")).toBeInTheDocument()
      expect(screen.queryByTestId("add-connector-card-telegram")).not.toBeInTheDocument()
    })
  })

  it("shows a no-results message when nothing matches", async () => {
    renderGrid()
    fireEvent.change(screen.getByTestId("add-connector-search"), { target: { value: "zzzz" } })
    await waitFor(() => {
      expect(screen.getByText(/no platforms match/i)).toBeInTheDocument()
    })
  })

  it("calls onPick with the chosen kind", () => {
    const { onPick } = renderGrid()
    fireEvent.click(screen.getByTestId("add-connector-card-matrix"))
    expect(onPick).toHaveBeenCalledWith("matrix")
  })
})
