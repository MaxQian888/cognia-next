/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  // `InstallButton` gates install on the desktop host, because the download
  // and checksum verification run in the Rust backend. These suites are about
  // what the surface renders and what it calls, not about the gate, which has
  // its own tests in `_shared/install-button.test.tsx`.
  canUseTauriInvoke: () => true,
}))

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

// GitHub marketplace catalogs the user/org added — the "Workspace" section.
const githubSourceEntries: Array<{ id: string; name: string }> = []
jest.mock("@/hooks/plugins/use-github-marketplace-sources", () => ({
  useGithubMarketplaceSources: () => ({
    sources: [],
    entries: githubSourceEntries,
    loading: false,
    errors: [],
    add: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    refresh: jest.fn(async () => undefined),
  }),
}))

// The Open VSX registry client. Mocked at the client seam rather than at the
// hook, so the section test exercises the real hook (debounce, paging, mapping)
// and can assert on what actually reaches the registry.
jest.mock("@/lib/plugin/vscode-shim/openvsx-client", () => ({
  getOpenVsxClient: jest.fn(),
}))

jest.mock("@/lib/plugin/vscode-shim/openvsx-install-flow", () => ({
  createOpenVsxInstallClient: jest.fn(() => ({
    getPlugin: jest.fn(async () => null),
    installPlugin: jest.fn(async () => undefined),
    discard: jest.fn(async () => undefined),
  })),
}))

import { __resetPluginMarketplaceClientForTests } from "@/hooks/plugins"
import { getOpenVsxClient } from "@/lib/plugin/vscode-shim/openvsx-client"
import { PluginMarketplace } from "./plugin-marketplace"

const getOpenVsxClientMock = getOpenVsxClient as jest.Mock

function openVsxEntry(name: string, overrides: Record<string, unknown> = {}) {
  return {
    namespace: "esbenp",
    name,
    version: "1.0.0",
    displayName: name,
    description: "an extension",
    downloadCount: 1,
    verified: true,
    files: { download: `https://open-vsx.org/${name}.vsix` },
    ...overrides,
  }
}

/** Install a fake registry and hand back the spy. */
function mockOpenVsxSearch(
  impl: (opts: Record<string, unknown>) => unknown = () => ({
    offset: 0,
    totalSize: 1,
    extensions: [openVsxEntry("prettier-vscode")],
  })
) {
  const searchExtensions = jest.fn(async (opts: Record<string, unknown>) => impl(opts))
  getOpenVsxClientMock.mockReturnValue({ searchExtensions })
  return searchExtensions
}

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
  githubSourceEntries.length = 0
  jest.clearAllMocks()
  mockOpenVsxSearch()
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
    const toolbar = screen.getByTestId("plugin-marketplace-toolbar")
    expect(toolbar).toHaveClass("min-w-0")
    expect(toolbar).toHaveAttribute("data-slot", "card")
    expect(toolbar.querySelector("[data-slot='card-content']")).not.toBeNull()
    expect(screen.getByTestId("plugin-marketplace-sections-scroller")).toHaveClass(
      "overflow-x-auto"
    )
    expect(screen.getByTestId("plugin-marketplace-sections-scroller")).not.toHaveClass(
      "sm:overflow-visible"
    )
    expect(screen.getByText("sections.featured")).toBeInTheDocument()
    expect(screen.getByText("sections.popular")).toBeInTheDocument()
    expect(screen.getByText("sections.recent")).toBeInTheDocument()
  })

  it("still renders all seven pre-existing sections alongside the new one", async () => {
    // Adding the 8th section must not disturb the 7 that were there.
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))
    for (const key of [
      "all",
      "featured",
      "popular",
      "recent",
      "builtin",
      "workspace",
      "shared",
      "vscode",
    ]) {
      expect(screen.getByText(`sections.${key}`)).toBeInTheDocument()
    }
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

  it("scopes Workspace to GitHub sources and Shared to the remote registry", async () => {
    const remoteOnly = [{ id: "remote-1", name: "RemoteOne", version: "1.0.0", type: "plugin" }]
    githubSourceEntries.push({ id: "ws-1", name: "WorkspaceOne" })
    __resetPluginMarketplaceClientForTests({
      searchPlugins: jest.fn(async () => remoteOnly),
      getFeaturedPlugins: jest.fn(async () => []),
      getPopularPlugins: jest.fn(async () => []),
      getRecentPlugins: jest.fn(async () => []),
      getPlugin: jest.fn(async () => null),
      installPlugin: jest.fn(async () => undefined),
      uninstallPlugin: jest.fn(async () => undefined),
    })
    render(<PluginMarketplace />)
    // Default "all" merges both sources.
    await waitFor(() => expect(screen.getByText("RemoteOne")).toBeInTheDocument())
    expect(screen.getByText("WorkspaceOne")).toBeInTheDocument()

    // Workspace = git sources only.
    fireEvent.click(screen.getByText("sections.workspace"))
    await waitFor(() => expect(screen.getByText("WorkspaceOne")).toBeInTheDocument())
    expect(screen.queryByText("RemoteOne")).not.toBeInTheDocument()

    // Shared = remote registry only.
    fireEvent.click(screen.getByText("sections.shared"))
    await waitFor(() => expect(screen.getByText("RemoteOne")).toBeInTheDocument())
    expect(screen.queryByText("WorkspaceOne")).not.toBeInTheDocument()
  })

  describe("VS Code section", () => {
    it("does not touch open-vsx.org until the section is opened", async () => {
      // Opening the Plugins page must not hit a third-party registry.
      const searchExtensions = mockOpenVsxSearch()
      render(<PluginMarketplace />)
      await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))

      expect(getOpenVsxClientMock).not.toHaveBeenCalled()
      expect(searchExtensions).not.toHaveBeenCalled()

      fireEvent.click(screen.getByText("sections.vscode"))
      await waitFor(() => expect(searchExtensions).toHaveBeenCalled())
    })

    it("vscode_section_queries_open_vsx_not_cognia_registry", async () => {
      const searchExtensions = mockOpenVsxSearch(() => ({
        offset: 0,
        totalSize: 1,
        extensions: [openVsxEntry("prettier-vscode", { displayName: "Prettier" })],
      }))
      const searchPlugins = jest.fn(async () => ENTRIES)
      __resetPluginMarketplaceClientForTests({
        searchPlugins,
        getFeaturedPlugins: jest.fn(async () => []),
        getPopularPlugins: jest.fn(async () => []),
        getRecentPlugins: jest.fn(async () => []),
        getPlugin: jest.fn(async () => null),
        installPlugin: jest.fn(async () => undefined),
        uninstallPlugin: jest.fn(async () => undefined),
      })

      render(<PluginMarketplace />)
      await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))
      // Whatever the page did on mount is the baseline; the property under
      // test is that opening the section adds nothing to it. (Mount issues
      // more than one cognia search — the Discovery strip queries too — so a
      // fixed expected count would be pinning an unrelated implementation
      // detail.)
      const cogniaCallsBeforeSwitch = searchPlugins.mock.calls.length
      expect(searchExtensions).not.toHaveBeenCalled()

      fireEvent.click(screen.getByText("sections.vscode"))

      // The section's entries come from Open VSX...
      await waitFor(() => expect(screen.getByText("Prettier")).toBeInTheDocument())
      expect(searchExtensions).toHaveBeenCalledWith(expect.objectContaining({ size: 12 }))
      // ...and browsing it never queries the cognia registry.
      expect(searchPlugins.mock.calls.length).toBe(cogniaCallsBeforeSwitch)
      // Cognia entries are not mixed into the section.
      expect(screen.queryByText("Alpha")).not.toBeInTheDocument()
    })

    it("pagination_maps_to_size_and_offset", async () => {
      // Server-side paging: "Load more" asks the registry for the next
      // window, it does not slice a pre-fetched list.
      const TOTAL = 20
      const searchExtensions = mockOpenVsxSearch((opts) => {
        const offset = opts.offset as number
        const size = opts.size as number
        const count = Math.max(0, Math.min(size, TOTAL - offset))
        return {
          offset,
          totalSize: TOTAL,
          extensions: Array.from({ length: count }, (_, i) => openVsxEntry(`ext-${offset + i}`)),
        }
      })

      render(<PluginMarketplace />)
      fireEvent.click(screen.getByText("sections.vscode"))

      await waitFor(() => expect(screen.getByText("ext-0")).toBeInTheDocument())
      // PAGE_SIZE = 12 maps onto the registry's `size`.
      expect(searchExtensions).toHaveBeenCalledWith(
        expect.objectContaining({ size: 12, offset: 0 })
      )
      expect(screen.getByText("ext-11")).toBeInTheDocument()
      expect(screen.queryByText("ext-12")).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId("plugin-marketplace-load-more"))

      await waitFor(() => expect(screen.getByText("ext-12")).toBeInTheDocument())
      expect(searchExtensions).toHaveBeenLastCalledWith(
        expect.objectContaining({ size: 12, offset: 12 })
      )
      // The first page is still on screen — pages accumulate.
      expect(screen.getByText("ext-0")).toBeInTheDocument()
      expect(screen.getByText("ext-19")).toBeInTheDocument()
    })

    it("surfaces an Open VSX failure without breaking the other sections", async () => {
      mockOpenVsxSearch(() => {
        throw new Error("HTTP 429")
      })
      render(<PluginMarketplace />)
      await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))

      fireEvent.click(screen.getByText("sections.vscode"))
      await waitFor(() => expect(screen.getByText("vscodeError")).toBeInTheDocument())

      // Switching back is unaffected — the failure is scoped to the section.
      fireEvent.click(screen.getByText("sections.all"))
      await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))
    })

    it("stays reachable when the cognia registry is down", async () => {
      // The VS Code section needs nothing from cognia's registry, so a
      // cognia-registry error must not gate it behind an error card.
      mockOpenVsxSearch()
      __resetPluginMarketplaceClientForTests({
        searchPlugins: jest.fn(async () => {
          throw new Error("registry unreachable")
        }),
        getFeaturedPlugins: jest.fn(async () => []),
        getPopularPlugins: jest.fn(async () => []),
        getRecentPlugins: jest.fn(async () => []),
        getPlugin: jest.fn(async () => null),
        installPlugin: jest.fn(async () => undefined),
        uninstallPlugin: jest.fn(async () => undefined),
      })

      render(<PluginMarketplace />)
      // The cognia error card is what renders first.
      await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument())

      fireEvent.click(screen.getByText("sections.vscode"))
      await waitFor(() => expect(screen.getByText("prettier-vscode")).toBeInTheDocument())
    })

    it("shows the persisted unsupported-API warning on an installed extension", async () => {
      // The warning is read back off the installed manifest, which is what
      // keeps it from vanishing once the install dialog closes.
      installedRows.push({
        id: "esbenp.prettier-vscode",
        name: "Prettier",
        version: "1.0.0",
        manifest: {
          vscodeExtension: { unsupportedApis: ["vscode.debug"] },
        },
      } as never)
      mockOpenVsxSearch()

      render(<PluginMarketplace />)
      fireEvent.click(screen.getByText("sections.vscode"))

      await waitFor(() =>
        expect(
          screen.getByTestId("plugin-openvsx-unsupported-esbenp.prettier-vscode")
        ).toBeInTheDocument()
      )
      // ...and the integrity badge appears only because it IS installed.
      expect(
        screen.getByTestId("plugin-openvsx-integrity-esbenp.prettier-vscode")
      ).toBeInTheDocument()
    })
  })
})
