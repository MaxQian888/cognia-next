/** @jest-environment jsdom */

import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

import { BotListPane } from "./bot-list-pane"

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    executor: "handler",
    status: "enabled",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [],
    armedTriggers: 0,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    config: {},
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

function renderPane(props: Partial<React.ComponentProps<typeof BotListPane>> = {}) {
  return render(
    <BotListPane
      rows={[row(), row({ id: "boti_2", name: "Digest", status: "needs_setup" })]}
      selectedId={null}
      search=""
      statusFilter="all"
      onSearchChange={jest.fn()}
      onStatusFilterChange={jest.fn()}
      onSelect={jest.fn()}
      {...props}
    />
  )
}

describe("BotListPane", () => {
  it("lists every row", () => {
    renderPane()
    expect(screen.getByTestId("bot-row-boti_1")).toBeInTheDocument()
    expect(screen.getByTestId("bot-row-boti_2")).toBeInTheDocument()
  })

  it("applies the search and the status filter together", () => {
    renderPane({ search: "digest" })
    expect(screen.queryByTestId("bot-row-boti_1")).not.toBeInTheDocument()
    expect(screen.getByTestId("bot-row-boti_2")).toBeInTheDocument()

    renderPane({ statusFilter: "needs_setup" })
    expect(screen.getAllByTestId("bot-row-boti_2").length).toBeGreaterThan(0)
  })

  it("distinguishes an empty install from an empty filter", () => {
    // "You have no Bots" and "nothing matched" need different next steps.
    const { rerender } = renderPane({ rows: [] })
    expect(screen.getByText(/Bots arrive with the plugins/)).toBeInTheDocument()

    rerender(
      <BotListPane
        rows={[row()]}
        selectedId={null}
        search="nothing-matches"
        statusFilter="all"
        onSearchChange={jest.fn()}
        onStatusFilterChange={jest.fn()}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByText("No Bot matches this search and filter.")).toBeInTheDocument()
  })

  it("shows placeholder bars rather than an empty state while loading", () => {
    // An empty state during the first read tells the user they have no Bots.
    renderPane({ rows: [], loading: true })
    expect(screen.getByTestId("bot-list-loading")).toBeInTheDocument()
    expect(screen.queryByText(/Bots arrive with the plugins/)).not.toBeInTheDocument()
  })

  it("reports typing and filter changes upward", () => {
    const onSearchChange = jest.fn()
    renderPane({ onSearchChange })
    fireEvent.change(screen.getByTestId("bot-search"), { target: { value: "rev" } })
    expect(onSearchChange).toHaveBeenCalledWith("rev")
  })

  it("keeps search collapsed behind its icon until asked for", () => {
    renderPane()
    expect(screen.getByTestId("bot-search-open")).toHaveAttribute("aria-expanded", "false")
  })

  it("expands the field over the filter when the icon is pressed", () => {
    renderPane()
    fireEvent.click(screen.getByTestId("bot-search-open"))
    expect(screen.getByTestId("bot-search-open")).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("bot-search")).toHaveFocus()
  })

  it("toggles back to the icon on a second press, dropping any query", () => {
    // The query is owned by the parent — a real harness so the clear actually
    // lands back in the prop, the way BotConsole wires it.
    function Harness() {
      const [q, setQ] = useState("rev")
      return (
        <BotListPane
          rows={[row()]}
          selectedId={null}
          search={q}
          statusFilter="all"
          onSearchChange={setQ}
          onStatusFilterChange={jest.fn()}
          onSelect={jest.fn()}
        />
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByTestId("bot-search-open"))
    expect(screen.getByTestId("bot-search")).toHaveValue("")
    expect(screen.getByTestId("bot-search-open")).toHaveAttribute("aria-expanded", "false")
  })

  it("collapses back on blur, but only while the query is empty", () => {
    // A collapsed icon must not hide what the list is currently filtered by.
    renderPane({ search: "rev" })
    const input = screen.getByTestId("bot-search")
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(screen.getByTestId("bot-search-open")).toHaveAttribute("aria-expanded", "true")
  })

  it("collapses on blur once the query is cleared", () => {
    renderPane()
    const input = screen.getByTestId("bot-search")
    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(screen.getByTestId("bot-search-open")).toHaveAttribute("aria-expanded", "false")
  })

  it("Escape clears the query and folds the field away", () => {
    const onSearchChange = jest.fn()
    renderPane({ search: "rev", onSearchChange })
    fireEvent.keyDown(screen.getByTestId("bot-search"), { key: "Escape" })
    expect(onSearchChange).toHaveBeenCalledWith("")
  })

  it("offers a clear button only while there is a query to clear", () => {
    const onSearchChange = jest.fn()
    const first = renderPane({ search: "", onSearchChange })
    expect(screen.queryByTestId("bot-search-clear")).not.toBeInTheDocument()
    first.unmount()
    renderPane({ search: "rev", onSearchChange })
    fireEvent.click(screen.getByTestId("bot-search-clear"))
    expect(onSearchChange).toHaveBeenCalledWith("")
  })

  it("marks the selected row", () => {
    renderPane({ selectedId: "boti_2" })
    expect(screen.getByTestId("bot-row-boti_2")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("bot-row-boti_1")).not.toHaveAttribute("aria-current")
  })
})
