/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
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

import { CAPABILITY_META } from "./plugin-capabilities"
import { PluginCategorySidebar, splitCapabilityRows } from "./plugin-category-sidebar"
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

  // A facet that can only filter to an empty list is noise; the rail used to
  // list ten of them, disabled.
  it("does not list a curated capability nothing declares", () => {
    render(<PluginCategorySidebar />)
    expect(screen.queryByText("capability.python")).toBeNull()
    expect(screen.getByText("capability.tools")).toBeInTheDocument()
  })

  it("keeps the ACTIVE facet listed even at zero, so it can be seen and cleared", () => {
    usePluginsStore.setState({ filters: { ...DEFAULT_PLUGIN_FILTERS, capability: "python" } })
    render(<PluginCategorySidebar />)
    const button = screen.getByText("capability.python").closest("button")!
    expect(button).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByText("all"))
    expect(usePluginsStore.getState().filters.capability).toBe("all")
  })

  it("names an uncurated capability instead of printing its id", () => {
    mockRows.push({ ...mockRows[0], id: "c", capabilities: ["agent-team-template"] })
    try {
      render(<PluginCategorySidebar />)
      expect(screen.getByText("capabilityName.agent-team-template")).toBeInTheDocument()
      expect(
        screen.getByText("capabilityName.agent-team-template").closest("button")
      ).toHaveAttribute("title", "agent-team-template")
    } finally {
      mockRows.pop()
    }
  })

  it("tells its host when a facet was chosen", () => {
    const onSelect = jest.fn()
    render(<PluginCategorySidebar onSelect={onSelect} />)
    fireEvent.click(screen.getByText("capability.tools"))
    expect(onSelect).toHaveBeenCalled()
  })
})

/**
 * `PluginCapability` has 69 members and `CAPABILITY_META` names 18, so a
 * curated-only rail could not filter on the other 51 even when installed
 * plugins declared them: the rail had no row and the axis was unreachable.
 */
describe("splitCapabilityRows", () => {
  it("keeps the curated rows in their declared order, counts and all", () => {
    const { curated } = splitCapabilityRows({ tools: 3 })
    expect(curated[0]).toMatchObject({ id: "tools", count: 3 })
    expect(curated.map((row) => row.id)).toEqual(CAPABILITY_META.map((meta) => meta.id))
  })

  it("surfaces an uncurated capability the library actually declares", () => {
    const { other } = splitCapabilityRows({ tools: 1, "pet-items": 2, subagents: 1 })
    expect(other).toEqual([
      { id: "pet-items", count: 2 },
      { id: "subagents", count: 1 },
    ])
  })

  // A curated row with no rows is still shown (disabled) so the rail keeps a
  // stable shape. An uncurated one at zero has nothing to offer at all.
  it("omits an uncurated capability nothing declares", () => {
    const { other } = splitCapabilityRows({ "pet-items": 0 })
    expect(other).toEqual([])
  })

  it("never lists a curated capability twice", () => {
    const { curated, other } = splitCapabilityRows({ tools: 5 })
    expect(other.some((row) => row.id === "tools")).toBe(false)
    expect(curated.filter((row) => row.id === "tools")).toHaveLength(1)
  })
})
