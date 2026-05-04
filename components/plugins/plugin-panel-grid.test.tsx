/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockRows: PluginRow[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

const setPluginEnabledMock = jest.fn(async (_id: string, _enabled: boolean) => undefined)
jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => mockRows),
  setPluginEnabled: (id: string, enabled: boolean) => setPluginEnabledMock(id, enabled),
}))

import { PluginPanelGrid } from "./plugin-panel-grid"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

beforeEach(() => {
  mockRows.length = 0
  setPluginEnabledMock.mockClear()
  usePluginsStore.setState({
    filters: DEFAULT_PLUGIN_FILTERS,
    selection: new Set(),
  })
})

describe("PluginPanelGrid", () => {
  it("renders the all-empty state with a marketplace CTA", () => {
    mockRows.length = 0
    render(<PluginPanelGrid />)
    expect(screen.getByText("emptyAll")).toBeInTheDocument()
    expect(screen.getByText("browseMarketplace")).toBeInTheDocument()
  })

  it("renders cards for each plugin row", () => {
    mockRows.push({
      id: "a",
      name: "Alpha",
      version: "1.0.0",
      status: "enabled",
      source: "builtin",
      type: "frontend",
      enabled: true,
      capabilities: ["tools"],
      path: "/",
      manifest: { id: "a" },
      createdAt: 1,
      updatedAt: 1,
    })
    render(<PluginPanelGrid />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
  })

  it("renders the filtered-empty state when filters exclude all rows", () => {
    mockRows.push({
      id: "a",
      name: "Alpha",
      version: "1.0.0",
      status: "enabled",
      source: "builtin",
      type: "frontend",
      enabled: true,
      capabilities: ["tools"],
      path: "/",
      manifest: { id: "a" },
      createdAt: 1,
      updatedAt: 1,
    })
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, capability: "themes" },
    })
    render(<PluginPanelGrid />)
    expect(screen.getByText("emptyFiltered")).toBeInTheDocument()
  })
})
