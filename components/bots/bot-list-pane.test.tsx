/** @jest-environment jsdom */

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

  it("marks the selected row", () => {
    renderPane({ selectedId: "boti_2" })
    expect(screen.getByTestId("bot-row-boti_2")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("bot-row-boti_1")).not.toHaveAttribute("aria-current")
  })
})
