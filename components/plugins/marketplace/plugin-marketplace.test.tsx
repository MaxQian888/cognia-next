/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const installedRows: Array<{ id: string }> = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => installedRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(async () => installedRows),
}))

import { __resetPluginMarketplaceClientForTests } from "@/hooks/plugins"
import { PluginMarketplace } from "./plugin-marketplace"

const ENTRIES = [
  {
    id: "alpha",
    name: "Alpha",
    version: "1.0.0",
    type: "plugin",
    description: "first",
  },
  {
    id: "beta",
    name: "Beta",
    version: "0.5.0",
    type: "plugin",
    description: "second",
  },
]

beforeEach(() => {
  installedRows.length = 0
  __resetPluginMarketplaceClientForTests({
    searchPlugins: jest.fn(async () => ENTRIES),
    getFeaturedPlugins: jest.fn(async () => ENTRIES.slice(0, 1)),
    getPopularPlugins: jest.fn(async () => ENTRIES),
    getRecentPlugins: jest.fn(async () => ENTRIES),
    getPlugin: jest.fn(async () => null),
    installPlugin: jest.fn(async () => undefined),
    uninstallPlugin: jest.fn(async () => undefined),
  })
})

describe("PluginMarketplace", () => {
  it("renders cards from the marketplace state", async () => {
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0)
  })

  it("renders the section toggle group", async () => {
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))
    expect(screen.getByText("sections.featured")).toBeInTheDocument()
    expect(screen.getByText("sections.popular")).toBeInTheDocument()
    expect(screen.getByText("sections.recent")).toBeInTheDocument()
  })

  it("lists built-in plugins in the dedicated Built-in section", async () => {
    installedRows.push({
      id: "builtin-1",
      name: "Builtin One",
      version: "1.0.0",
      source: "builtin",
      capabilities: [],
      manifest: {},
    } as never)
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))
    fireEvent.click(screen.getByText("sections.builtin"))
    await waitFor(() => expect(screen.getByText("Builtin One")).toBeInTheDocument())
  })

  it("install click invokes the marketplace install path", async () => {
    const install = jest.fn(async () => undefined)
    __resetPluginMarketplaceClientForTests({
      searchPlugins: jest.fn(async () => ENTRIES),
      getFeaturedPlugins: jest.fn(async () => ENTRIES),
      getPopularPlugins: jest.fn(async () => ENTRIES),
      getRecentPlugins: jest.fn(async () => ENTRIES),
      getPlugin: jest.fn(async () => ({
        manifest: {
          id: "alpha",
          name: "Alpha",
          version: "1.0.0",
          type: "frontend" as const,
          capabilities: [] as never[],
        } as never,
        name: "Alpha",
      })),
      installPlugin: install,
      uninstallPlugin: jest.fn(async () => undefined),
    })
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))
    const installButtons = screen.getAllByText("install")
    fireEvent.click(installButtons[0])
    await waitFor(() => expect(install).toHaveBeenCalled())
  })

  it("renders Load more when results exceed PAGE_SIZE and expands on click", async () => {
    // PAGE_SIZE = 12, so 14 entries → 12 visible + a Load-more CTA;
    // click reveals the remaining two.
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `plug-${i}`,
      name: `Plugin ${i}`,
      version: "1.0.0",
      type: "plugin",
      description: `entry ${i}`,
    }))
    __resetPluginMarketplaceClientForTests({
      searchPlugins: jest.fn(async () => many),
      getFeaturedPlugins: jest.fn(async () => []),
      getPopularPlugins: jest.fn(async () => []),
      getRecentPlugins: jest.fn(async () => []),
      getPlugin: jest.fn(async () => null),
      installPlugin: jest.fn(async () => undefined),
      uninstallPlugin: jest.fn(async () => undefined),
    })
    render(<PluginMarketplace />)
    await waitFor(() =>
      expect(screen.getByTestId("plugin-marketplace-load-more")).toBeInTheDocument()
    )
    expect(screen.getByText("Plugin 0")).toBeInTheDocument()
    expect(screen.getByText("Plugin 11")).toBeInTheDocument()
    expect(screen.queryByText("Plugin 12")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("plugin-marketplace-load-more"))
    await waitFor(() => expect(screen.getByText("Plugin 12")).toBeInTheDocument())
    expect(screen.getByText("Plugin 13")).toBeInTheDocument()
  })

  it("switching sections swaps the entry list and resets pagination", async () => {
    // Distinct entries per source so the section toggle has something
    // observable to flip between. After switching to "popular", we should
    // see the popular-only id and stop seeing the search-only ones.
    const searchOnly = [{ id: "search-1", name: "SearchOne", version: "1.0.0", type: "plugin" }]
    const popularOnly = [{ id: "popular-1", name: "PopularOne", version: "1.0.0", type: "plugin" }]
    __resetPluginMarketplaceClientForTests({
      searchPlugins: jest.fn(async () => searchOnly),
      getFeaturedPlugins: jest.fn(async () => []),
      getPopularPlugins: jest.fn(async () => popularOnly),
      getRecentPlugins: jest.fn(async () => []),
      getPlugin: jest.fn(async () => null),
      installPlugin: jest.fn(async () => undefined),
      uninstallPlugin: jest.fn(async () => undefined),
    })
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getByText("SearchOne")).toBeInTheDocument())
    expect(screen.queryByText("PopularOne")).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("sections.popular"))
    await waitFor(() => expect(screen.getByText("PopularOne")).toBeInTheDocument())
    expect(screen.queryByText("SearchOne")).not.toBeInTheDocument()
  })
})
