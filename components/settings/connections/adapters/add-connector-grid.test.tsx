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

  it("clears the query and reports close when the dialog is dismissed", async () => {
    const { onOpenChange } = renderGrid()
    fireEvent.change(screen.getByTestId("add-connector-search"), { target: { value: "lark" } })
    fireEvent.keyDown(screen.getByTestId("add-connector-search"), { key: "Escape" })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("calls onPick with the chosen kind", () => {
    const { onPick } = renderGrid()
    fireEvent.click(screen.getByTestId("add-connector-card-matrix"))
    expect(onPick).toHaveBeenCalledWith("matrix")
  })

  describe("planned kinds (dormancy label — UI axis)", () => {
    it("renders a disabled 'Planned' card with no pick handler", () => {
      const { onPick } = renderGrid({ plannedKinds: ["kook", "email"] })
      const card = screen.getByTestId("add-connector-card-kook")
      expect(card).toBeDisabled()
      expect(card).toHaveAttribute("aria-disabled", "true")
      expect(card).toHaveAttribute("data-planned", "true")
      expect(screen.getByTestId("add-connector-planned-kook")).toHaveTextContent("Planned")
      expect(screen.getByText("KOOK")).toBeInTheDocument()
      fireEvent.click(card)
      expect(onPick).not.toHaveBeenCalled()
    })

    it("lists planned cards after the configurable ones and never shows a count badge for them", () => {
      renderGrid({
        plannedKinds: ["email"],
        configuredCounts: new Map<PlatformKind, number>([
          ["telegram", 2],
          ["email", 5],
        ]),
      })
      const cards = screen.getAllByTestId(/^add-connector-card-/)
      expect(cards.map((c) => c.getAttribute("data-testid"))).toEqual([
        "add-connector-card-telegram",
        "add-connector-card-matrix",
        "add-connector-card-lark",
        "add-connector-card-email",
      ])
      expect(screen.queryByTestId("add-connector-count-email")).not.toBeInTheDocument()
      expect(screen.getByTestId("add-connector-planned-email")).toBeInTheDocument()
    })

    it("does not duplicate a kind that is both configurable and (stale) planned", () => {
      renderGrid({ plannedKinds: ["telegram"] })
      expect(screen.getAllByTestId("add-connector-card-telegram")).toHaveLength(1)
      expect(screen.getByTestId("add-connector-card-telegram")).not.toBeDisabled()
    })

    it("planned cards participate in search", async () => {
      renderGrid({ plannedKinds: ["mattermost"] })
      fireEvent.change(screen.getByTestId("add-connector-search"), {
        target: { value: "matter" },
      })
      await waitFor(() => {
        expect(screen.getByTestId("add-connector-card-mattermost")).toBeInTheDocument()
        expect(screen.queryByTestId("add-connector-card-telegram")).not.toBeInTheDocument()
      })
    })
  })
})
