/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockRows: PluginRow[] = [
  {
    id: "a",
    name: "A",
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
  },
  {
    id: "b",
    name: "B",
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: ["themes"],
    path: "/",
    manifest: { id: "b" },
    createdAt: 1,
    updatedAt: 1,
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => mockRows),
}))

import { PluginCategorySidebar } from "./plugin-category-sidebar"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

beforeEach(() => {
  usePluginsStore.setState({ filters: DEFAULT_PLUGIN_FILTERS })
})

describe("PluginCategorySidebar", () => {
  it("renders the All option with the total count", () => {
    render(<PluginCategorySidebar />)
    expect(screen.getByText("all")).toBeInTheDocument()
  })

  it("clicking a capability sets the store filter", () => {
    render(<PluginCategorySidebar />)
    // Find "tools" entry and click it.
    fireEvent.click(screen.getByText("capability.tools"))
    expect(usePluginsStore.getState().filters.capability).toBe("tools")
  })

  it("zero-count categories are disabled", () => {
    render(<PluginCategorySidebar />)
    const button = screen.getByText("capability.python").closest("button")
    expect(button).toBeDisabled()
  })
})
