/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

const mockRows: PluginRow[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => mockRows),
}))

import { PluginPanelHeader } from "./plugin-panel-header"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

beforeEach(() => {
  usePluginsStore.setState({
    filters: DEFAULT_PLUGIN_FILTERS,
    filterSheetOpen: false,
  })
})

describe("PluginPanelHeader", () => {
  it("renders the title and total badge", () => {
    render(<PluginPanelHeader />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("panel.totalBadge:0")).toBeInTheDocument()
  })

  it("filters button opens the filter sheet", () => {
    render(<PluginPanelHeader />)
    fireEvent.click(screen.getByText("panel.filtersButton"))
    expect(usePluginsStore.getState().filterSheetOpen).toBe(true)
  })

  it("typing in the search input updates the filter query", () => {
    render(<PluginPanelHeader />)
    const input = screen.getByPlaceholderText("panel.searchPlaceholder")
    fireEvent.change(input, { target: { value: "alpha" } })
    expect(usePluginsStore.getState().filters.query).toBe("alpha")
  })
})
