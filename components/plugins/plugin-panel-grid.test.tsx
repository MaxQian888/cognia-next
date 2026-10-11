/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}))

const mockRows: PluginRow[] = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

const setPluginEnabledForHostMock = jest.fn(async (_id: string, _enabled: boolean) => ({
  ok: true,
}))
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  setPluginEnabledForHost: (id: string, enabled: boolean) =>
    setPluginEnabledForHostMock(id, enabled),
  isMirroredPluginClient: () => false,
}))
jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => mockRows),
}))

import { PluginPanelGrid } from "./plugin-panel-grid"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

beforeEach(() => {
  mockRows.length = 0
  setPluginEnabledForHostMock.mockClear()
  usePluginsStore.setState({
    filters: DEFAULT_PLUGIN_FILTERS,
    selection: new Set(),
  })
})

describe("PluginPanelGrid", () => {
  // Loading and both empty states belong to `PluginLibraryList`, which only
  // mounts the grid once it has rows (see its own tests).
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

  it("renders only the rows the filters keep", () => {
    for (const [id, capability] of [
      ["a", "tools"],
      ["b", "themes"],
    ]) {
      mockRows.push({
        id,
        name: id === "a" ? "Alpha" : "Beta",
        version: "1.0.0",
        status: "installed",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: [capability],
        path: "/",
        manifest: { id },
        createdAt: 1,
        updatedAt: 1,
      })
    }
    usePluginsStore.setState({
      filters: { ...DEFAULT_PLUGIN_FILTERS, capability: "themes" },
    })
    render(<PluginPanelGrid />)
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument()
  })
})
