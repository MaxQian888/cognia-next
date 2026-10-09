/** @jest-environment jsdom */

// The agents list (ADR-0220): one component for the desktop rail and the
// phone page. Cases cover what a row says, the search / sort / source
// controls, the loading / empty / no-match branches, and the select mode with
// its batch export and delete.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Character } from "@cognia/agent-config-types"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { AgentSummary } from "@/lib/agents/agent-activity"

const mockActions = {
  duplicate: jest.fn(),
  createVariant: jest.fn(),
  detachVariant: jest.fn(),
  resetVariant: jest.fn(),
  remove: jest.fn(),
  removeMany: jest.fn((_agents: readonly Character[]) => Promise.resolve(0)),
  exportMany: jest.fn((_agents: readonly Character[]) => undefined),
  exportPack: jest.fn(),
  recloneFromPack: jest.fn(),
  dismissUpdate: jest.fn(),
  applyUpdateForPack: jest.fn(),
  requestApplyUpdate: jest.fn(),
  applyUpdateTarget: null as Character | null,
  confirmApplyUpdate: jest.fn(),
  cancelApplyUpdate: jest.fn(),
}
jest.mock("@/hooks/agents/use-agent-actions", () => ({
  useAgentActions: () => mockActions,
}))

// The live pack the clone below was taken from has moved on to 2.0.0.
jest.mock("@/lib/plugin/registries/character-pack-registry", () => ({
  ...jest.requireActual("@/lib/plugin/registries/character-pack-registry"),
  listCharacterPackEntries: jest.fn(() => [
    { pluginId: "plug", entry: { id: "pack", version: "2.0.0" } },
  ]),
  getPackWarnings: jest.fn(() => []),
  getPackCharacterWarnings: jest.fn(() => []),
}))

jest.mock("@/components/mobile/mobile-spot-icon", () => ({
  MobileSpotIcon: () => <span data-testid="spot-icon" />,
}))

import { AgentListPane, type AgentListPaneProps } from "./agent-list-pane"

function agent(over: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Alpha",
    avatarColor: "#123456",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as Character
}

function summary(over: Partial<AgentSummary> = {}): AgentSummary {
  return { status: "idle", turns: 0, conversations: 0, ...over }
}

const alpha = agent({ id: "a", name: "Alpha", updatedAt: 3 })
const beta = agent({ id: "b", name: "Beta", updatedAt: 2, isBuiltIn: true })
const gamma = agent({
  id: "c",
  name: "Gamma",
  updatedAt: 1,
  sourcePluginId: "plug",
  sourcePackId: "pack",
  packVersionAtClone: "1.0.0",
})

function props(over: Partial<AgentListPaneProps> = {}): AgentListPaneProps {
  return {
    agents: [alpha, beta, gamma],
    summaries: new Map(),
    query: "",
    source: "all",
    sort: "name",
    onQueryChange: jest.fn(),
    onSourceChange: jest.fn(),
    onSortChange: jest.fn(),
    onSelect: jest.fn(),
    ...over,
  }
}

function renderPane(over: Partial<AgentListPaneProps> = {}) {
  const p = props(over)
  const utils = render(
    <TooltipProvider>
      <AgentListPane {...p} />
    </TooltipProvider>
  )
  return { ...utils, props: p }
}

function rowNames() {
  return screen.getAllByTestId("agent-list-row").map((row) => row.getAttribute("data-agent-id"))
}

const registry = jest.requireMock("@/lib/plugin/registries/character-pack-registry") as {
  getPackWarnings: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
  mockActions.removeMany.mockImplementation(() => Promise.resolve(0))
  registry.getPackWarnings.mockImplementation(() => [])
})

describe("loading and empty", () => {
  it("shows the skeleton while the first read is in flight, without the controls", () => {
    renderPane({ agents: undefined })
    expect(screen.getByTestId("agent-list-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-list-search")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-list-select")).not.toBeInTheDocument()
  })

  it("offers to create the first agent when there is none", () => {
    const onCreate = jest.fn()
    renderPane({ agents: [], onCreate })
    expect(screen.getByText("No agents yet")).toBeInTheDocument()
    expect(screen.getByText(/Start blank, or describe one/)).toBeInTheDocument()
    expect(screen.queryByTestId("agent-list-search")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("agent-list-create"))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it("has no create button when the host offers none", () => {
    renderPane({ agents: [] })
    expect(screen.getByText("No agents yet")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-list-create")).not.toBeInTheDocument()
  })

  it("says nothing matches and clears both filters", () => {
    const { props: p } = renderPane({ query: "zzz", source: "user" })
    expect(screen.getByTestId("agent-list-no-matches")).toHaveTextContent("No agents match.")
    expect(screen.queryByTestId("agent-list")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(p.onQueryChange).toHaveBeenCalledWith("")
    expect(p.onSourceChange).toHaveBeenCalledWith("all")
  })
})

describe("rows", () => {
  it("lists the agents filtered by source and query, in the chosen order", () => {
    const { rerender, props: p } = renderPane({ sort: "name" })
    expect(rowNames()).toEqual(["a", "b", "c"])
    rerender(
      <TooltipProvider>
        <AgentListPane {...p} sort="updated" source="user" />
      </TooltipProvider>
    )
    expect(rowNames()).toEqual(["a"])
    rerender(
      <TooltipProvider>
        <AgentListPane {...p} query="gam" />
      </TooltipProvider>
    )
    expect(rowNames()).toEqual(["c"])
  })

  it("orders by last activity under the recent sort", () => {
    renderPane({
      sort: "recent",
      summaries: new Map([
        ["b", summary({ lastActiveAt: 100 })],
        ["c", summary({ lastActiveAt: 200 })],
      ]),
    })
    expect(rowNames()).toEqual(["c", "b", "a"])
  })

  it("opens an agent on click and marks the open one", () => {
    const { props: p } = renderPane({ selectedId: "b" })
    const rows = screen.getAllByTestId("agent-list-row")
    expect(rows[1]).toHaveAttribute("aria-current", "true")
    expect(rows[0]).not.toHaveAttribute("aria-current")
    expect(rows[0]).not.toHaveAttribute("aria-pressed")
    fireEvent.click(rows[0]!)
    expect(p.onSelect).toHaveBeenCalledWith("a")
  })

  it("says when an agent is working or waiting, and nothing when idle", () => {
    renderPane({
      summaries: new Map([
        ["a", summary({ status: "running" })],
        ["c", summary({ status: "awaiting" })],
      ]),
    })
    const statuses = screen.getAllByTestId("agent-list-status")
    expect(statuses.map((s) => s.textContent)).toEqual(["Working", "Needs you"])
    expect(statuses[0]!.className).toContain("text-emerald-600")
    expect(statuses[1]!.className).toContain("text-amber-600")
  })

  it("badges an idle built-in agent, but not one that is working", () => {
    const { rerender, props: p } = renderPane()
    const builtInRow = screen.getAllByTestId("agent-list-row")[1]!
    expect(within(builtInRow).getByText("Built-in")).toBeInTheDocument()
    rerender(
      <TooltipProvider>
        <AgentListPane {...p} summaries={new Map([["b", summary({ status: "running" })]])} />
      </TooltipProvider>
    )
    const row = screen.getAllByTestId("agent-list-row")[1]!
    expect(within(row).queryByText("Built-in")).not.toBeInTheDocument()
    expect(within(row).getByTestId("agent-list-status")).toHaveTextContent("Working")
  })

  it("flags a clone whose pack has an update", () => {
    renderPane()
    const flags = screen.getAllByTestId("agent-list-flag")
    expect(flags).toHaveLength(1)
    expect(flags[0]).toHaveAttribute("title", "Pack update available")
    expect(screen.getAllByTestId("agent-list-row")[2]).toContainElement(flags[0]!)
  })

  it("flags a pack agent with a missing dependency", () => {
    registry.getPackWarnings.mockImplementation(() => [{ kind: "skill", id: "x" }])
    renderPane({
      agents: [agent({ id: "w", name: "Warned", sourcePluginId: "plug", sourcePackId: "pack" })],
    })
    expect(screen.getByTestId("agent-list-flag")).toHaveAttribute("title", "Missing a dependency")
  })

  it("shows the description, else when it was last active, else that it never was", () => {
    renderPane({
      agents: [
        agent({ id: "a", name: "A", description: "  Writes docs  " }),
        agent({ id: "b", name: "B" }),
        agent({ id: "c", name: "C" }),
      ],
      summaries: new Map([["b", summary({ lastActiveAt: Date.UTC(2026, 0, 2) })]]),
    })
    const rows = screen.getAllByTestId("agent-list-row")
    expect(rows[0]).toHaveTextContent("Writes docs")
    expect(rows[1]).toHaveTextContent("Active 2026-01-02T00:00:00.000Z")
    expect(rows[2]).toHaveTextContent("Not used yet")
  })

  it("stands the rows on one grouped surface on the page variant", () => {
    renderPane({ variant: "page", className: "extra" })
    const pane = screen.getByTestId("agent-list-pane")
    expect(pane).toHaveAttribute("data-variant", "page")
    expect(pane.className).toContain("extra")
    expect(screen.getByTestId("agent-list").className).toContain("divide-y")
    expect(screen.getAllByTestId("agent-list-row")[0]!.className).toContain("rounded-none")
  })

  it("defaults to the rail variant", () => {
    renderPane()
    expect(screen.getByTestId("agent-list-pane")).toHaveAttribute("data-variant", "rail")
    expect(screen.getByTestId("agent-list").className).toContain("space-y-0.5")
  })
})

describe("controls", () => {
  it("writes the typed query through", () => {
    const { props: p } = renderPane()
    const box = screen.getByTestId("agent-list-search")
    expect(box).toHaveAttribute("placeholder", "Search agents…")
    fireEvent.change(box, { target: { value: "be" } })
    expect(p.onQueryChange).toHaveBeenCalledWith("be")
    expect(box).toHaveValue("be")
  })

  it("follows a query changed from outside the box", () => {
    const { rerender, props: p } = renderPane({ query: "al" })
    expect(screen.getByTestId("agent-list-search")).toHaveValue("al")
    rerender(
      <TooltipProvider>
        <AgentListPane {...p} query="" />
      </TooltipProvider>
    )
    expect(screen.getByTestId("agent-list-search")).toHaveValue("")
  })

  it("picks a sort from the menu", async () => {
    const user = userEvent.setup()
    const { props: p } = renderPane({ sort: "name" })
    await user.click(screen.getByTestId("agent-list-sort"))
    expect(await screen.findByTestId("agent-list-sort-name")).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(screen.getByTestId("agent-list-sort-recent")).toHaveTextContent("Last active")
    await user.click(screen.getByTestId("agent-list-sort-updated"))
    expect(p.onSortChange).toHaveBeenCalledWith("updated")
  })

  it("counts each source on its chip", () => {
    renderPane()
    expect(screen.getByTestId("agent-list-source-all")).toHaveAccessibleName("All: 3")
    expect(screen.getByTestId("agent-list-source-user")).toHaveAccessibleName("Mine: 1")
    expect(screen.getByTestId("agent-list-source-builtin")).toHaveAccessibleName("Built-in: 1")
    expect(screen.getByTestId("agent-list-source-plugin")).toHaveAccessibleName("Plugin: 1")
    expect(screen.getByTestId("agent-list-source-all")).toHaveAttribute("data-state", "on")
  })

  it("switches the source, and falls back to all when the active chip is pressed again", async () => {
    const user = userEvent.setup()
    const { props: p } = renderPane({ source: "user" })
    await user.click(screen.getByTestId("agent-list-source-plugin"))
    expect(p.onSourceChange).toHaveBeenLastCalledWith("plugin")
    await user.click(screen.getByTestId("agent-list-source-user"))
    expect(p.onSourceChange).toHaveBeenLastCalledWith("all")
  })
})

describe("select mode", () => {
  async function enterSelection(over: Partial<AgentListPaneProps> = {}) {
    const user = userEvent.setup()
    const result = renderPane(over)
    await user.click(screen.getByTestId("agent-list-select"))
    return { user, ...result }
  }

  it("is off until Select is pressed", () => {
    renderPane()
    const button = screen.getByTestId("agent-list-select")
    expect(button).toHaveAccessibleName("Select")
    expect(button).toHaveAttribute("aria-pressed", "false")
    expect(screen.queryByTestId("agent-list-bulk")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-list-select-all")).not.toBeInTheDocument()
  })

  it("turns rows into toggles instead of opening agents", async () => {
    const { user, props: p } = await enterSelection({ selectedId: "a" })
    expect(screen.getByTestId("agent-list-select")).toHaveAccessibleName("Done")
    expect(screen.getByTestId("agent-list-select")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("agent-list-bulk")).toHaveTextContent("None selected")
    expect(screen.getByTestId("agent-list-bulk-export")).toBeDisabled()
    expect(screen.getByTestId("agent-list-bulk-delete")).toBeDisabled()

    const rows = screen.getAllByTestId("agent-list-row")
    // Selection hides which agent is open.
    expect(rows[0]).not.toHaveAttribute("aria-current")
    expect(rows[0]).toHaveAttribute("aria-pressed", "false")
    await user.click(rows[0]!)
    expect(p.onSelect).not.toHaveBeenCalled()
    expect(screen.getAllByTestId("agent-list-row")[0]).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("agent-list-bulk")).toHaveTextContent("1 selected")
    expect(screen.getByTestId("agent-list-bulk-export")).toBeEnabled()

    await user.click(screen.getAllByTestId("agent-list-row")[0]!)
    expect(screen.getAllByTestId("agent-list-row")[0]).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("agent-list-bulk")).toHaveTextContent("None selected")
  })

  it("selects every visible row and clears them again", async () => {
    const { user } = await enterSelection({ source: "all", query: "" })
    const selectAll = screen.getByTestId("agent-list-select-all")
    expect(screen.getByText("Select all shown")).toBeInTheDocument()
    expect(selectAll).toHaveAttribute("aria-checked", "false")
    await user.click(selectAll)
    expect(screen.getByTestId("agent-list-select-all")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("agent-list-bulk")).toHaveTextContent("3 selected")
    await user.click(screen.getByTestId("agent-list-select-all"))
    expect(screen.getByTestId("agent-list-bulk")).toHaveTextContent("None selected")
  })

  it("selects only the rows the filter shows", async () => {
    const { user } = await enterSelection({ query: "gam" })
    await user.click(screen.getByTestId("agent-list-select-all"))
    expect(screen.getByTestId("agent-list-bulk")).toHaveTextContent("1 selected")
    await user.click(screen.getByTestId("agent-list-bulk-export"))
    expect(mockActions.exportMany).toHaveBeenCalledWith([gamma])
  })

  it("exports the chosen agents", async () => {
    const { user } = await enterSelection()
    const rows = screen.getAllByTestId("agent-list-row")
    await user.click(rows[0]!)
    await user.click(rows[2]!)
    await user.click(screen.getByTestId("agent-list-bulk-export"))
    expect(mockActions.exportMany).toHaveBeenCalledWith([alpha, gamma])
    // Export does not leave the mode.
    expect(screen.getByTestId("agent-list-bulk")).toBeInTheDocument()
  })

  it("asks before deleting, then deletes the chosen agents and leaves selection", async () => {
    let resolve: (n: number) => void = () => undefined
    mockActions.removeMany.mockImplementation(() => new Promise<number>((r) => (resolve = r)))
    const { user } = await enterSelection()
    const rows = screen.getAllByTestId("agent-list-row")
    await user.click(rows[0]!)
    await user.click(rows[1]!)
    await user.click(screen.getByTestId("agent-list-bulk-delete"))

    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Delete 2 agents?")).toBeInTheDocument()
    expect(
      within(dialog).getByText(/Built-in agents, agents a plugin provides/)
    ).toBeInTheDocument()
    await user.click(screen.getByTestId("agent-list-bulk-confirm"))
    expect(mockActions.removeMany).toHaveBeenCalledWith([alpha, beta])
    // Still selecting until the delete settles.
    expect(screen.getByTestId("agent-list-bulk")).toBeInTheDocument()

    resolve(2)
    await waitFor(() => expect(screen.queryByTestId("agent-list-bulk")).not.toBeInTheDocument())
    expect(screen.getByTestId("agent-list-select")).toHaveAccessibleName("Select")
  })

  it("keeps the selection when the delete is cancelled", async () => {
    const { user } = await enterSelection()
    await user.click(screen.getAllByTestId("agent-list-row")[0]!)
    await user.click(screen.getByTestId("agent-list-bulk-delete"))
    const dialog = await screen.findByRole("alertdialog")
    // The jest next-intl stub resolves only `=N` / `other` plural branches.
    expect(within(dialog).getByText(/^Delete 1 agents?\?$/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(mockActions.removeMany).not.toHaveBeenCalled()
    expect(screen.getByTestId("agent-list-bulk")).toHaveTextContent("1 selected")
  })

  it("Done leaves the mode and forgets the selection", async () => {
    const { user } = await enterSelection()
    await user.click(screen.getAllByTestId("agent-list-row")[0]!)
    await user.click(screen.getByTestId("agent-list-select"))
    expect(screen.queryByTestId("agent-list-bulk")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("agent-list-select"))
    expect(screen.getByTestId("agent-list-bulk")).toHaveTextContent("None selected")
  })
})
