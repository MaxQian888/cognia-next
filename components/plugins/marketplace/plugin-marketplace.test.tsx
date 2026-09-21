/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"

const mockCanUseTauriInvoke = jest.fn(() => true)
jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  // `InstallButton` gates install on the desktop host, because the download
  // and checksum verification run in the Rust backend. These suites are about
  // what the surface renders and what it calls, not about the gate, which has
  // its own tests in `_shared/install-button.test.tsx`.
  canUseTauriInvoke: () => mockCanUseTauriInvoke(),
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
const githubSourcePresets: MarketplacePreset[] = []
jest.mock("@/hooks/plugins/use-github-marketplace-sources", () => ({
  useGithubMarketplaceSources: () => ({
    sources: [],
    entries: githubSourceEntries,
    presets: githubSourcePresets,
    loading: false,
    errors: [],
    add: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    refresh: jest.fn(async () => undefined),
  }),
}))

// Preset bundles install through the shared sequential runner — mocked at the
// lib seam so the suite asserts the component's wiring and toast branches, not
// the runner's own mechanics (covered by preset-install.test.ts).
const runPresetInstallMock = jest.fn()
jest.mock("@/lib/plugin/marketplace/preset-install", () => ({
  runPresetInstall: (args: unknown) => runPresetInstallMock(args),
}))

const mockToast = { error: jest.fn(), message: jest.fn(), warning: jest.fn(), success: jest.fn() }
// Lazy getter: the factory runs while the file's imports are still resolving,
// before `mockToast` above is initialized — deferring the property access is
// what keeps this out of the TDZ.
jest.mock("sonner", () => ({
  get toast() {
    return mockToast
  },
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
import type { MarketplacePreset } from "@/lib/plugin/package/github-marketplace"
import { getOpenVsxClient } from "@/lib/plugin/vscode-shim/openvsx-client"
import { usePluginsStore } from "@/stores/plugins"
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
  // Both Discover axes live in the plugins store now, so reset them or a
  // previous case leaks its origin into the next one.
  usePluginsStore.setState({ discoverCuration: "all", discoverOrigin: "all" })
  installedRows.length = 0
  githubSourceEntries.length = 0
  githubSourcePresets.length = 0
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

  /**
   * The eight-item switch that used to live in this pane mixed curation
   * (all / featured / popular / recent) with origin (builtin / workspace /
   * shared / vscode). It moved to `PluginDiscoverHeader` in the page header
   * and became two controls, so the pane keeps only the actions that open
   * something.
   */
  it("no longer draws its own toolbar", async () => {
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0))
    expect(screen.queryByTestId("plugin-marketplace-toolbar")).toBeNull()
    expect(screen.queryByTestId("plugin-marketplace-sections-scroller")).toBeNull()
    expect(screen.getByTestId("plugin-marketplace-manage-sources")).toBeInTheDocument()
  })

  // The two axes are independent: a ranking narrows the registry's answer,
  // and the origin decides whose answer is read at all. A git catalog
  // publishes no featured / popular / recent list, so it drops out under a
  // ranking rather than being presented as if it had one.
  it("narrows to the registry's ranked list when a ranking is chosen", async () => {
    githubSourceEntries.push({ id: "ws-1", name: "WorkspaceOne" })
    render(<PluginMarketplace />)
    await waitFor(() => expect(screen.getAllByText("Beta").length).toBeGreaterThan(0))
    expect(screen.getByText("WorkspaceOne")).toBeInTheDocument()

    // `getFeaturedPlugins` returns only the first entry in this suite.
    act(() => usePluginsStore.getState().setDiscoverCuration("featured"))
    await waitFor(() => expect(screen.queryByText("WorkspaceOne")).toBeNull())
    expect(screen.queryByText("Beta")).toBeNull()
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0)
  })

  it("clears a ranking the newly picked origin cannot answer", () => {
    act(() => usePluginsStore.getState().setDiscoverCuration("featured"))
    act(() => usePluginsStore.getState().setDiscoverOrigin("vscode"))
    expect(usePluginsStore.getState().discoverCuration).toBe("all")
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
    act(() => usePluginsStore.getState().setDiscoverOrigin("builtin"))
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

    act(() => usePluginsStore.getState().setDiscoverCuration("popular"))
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
    act(() => usePluginsStore.getState().setDiscoverOrigin("workspace"))
    await waitFor(() => expect(screen.getByText("WorkspaceOne")).toBeInTheDocument())
    expect(screen.queryByText("RemoteOne")).not.toBeInTheDocument()

    // Shared = remote registry only.
    act(() => usePluginsStore.getState().setDiscoverOrigin("registry"))
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

      act(() => usePluginsStore.getState().setDiscoverOrigin("vscode"))
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

      act(() => usePluginsStore.getState().setDiscoverOrigin("vscode"))

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
      act(() => usePluginsStore.getState().setDiscoverOrigin("vscode"))

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

      act(() => usePluginsStore.getState().setDiscoverOrigin("vscode"))
      await waitFor(() => expect(screen.getByText("vscodeError")).toBeInTheDocument())

      // Switching back is unaffected — the failure is scoped to the section.
      act(() => usePluginsStore.getState().setDiscoverOrigin("all"))
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

      act(() => usePluginsStore.getState().setDiscoverOrigin("vscode"))
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
      act(() => usePluginsStore.getState().setDiscoverOrigin("vscode"))

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

  describe("preset bundles", () => {
    const presetMember = (id: string) => ({
      id,
      name: id,
      version: "1.0.0",
      type: "plugin" as const,
      source: "git" as const,
      github: { owner: "acme", repo: "repo" },
    })
    const preset = (id: string, memberIds: string[]): MarketplacePreset => ({
      id,
      name: id.split(":").pop() ?? id,
      members: memberIds.map(presetMember),
      missingPlugins: [],
    })
    const result = (over: Record<string, unknown> = {}) => ({
      installed: [],
      failed: [],
      cancelled: [],
      skipped: [],
      ...over,
    })

    it("renders catalog presets in the Workspace section and runs the install", async () => {
      githubSourcePresets.push(preset("acme/repo:starter", ["p-one", "p-two"]))
      runPresetInstallMock.mockResolvedValue(result({ installed: ["p-one", "p-two"] }))
      render(<PluginMarketplace />)
      act(() => usePluginsStore.getState().setDiscoverOrigin("workspace"))

      const installBtn = await screen.findByTestId("preset-install-acme/repo:starter")
      fireEvent.click(installBtn)

      await waitFor(() => expect(runPresetInstallMock).toHaveBeenCalledTimes(1))
      const args = runPresetInstallMock.mock.calls[0][0] as {
        members: Array<{ id: string }>
        isInstalled: (id: string) => boolean
        install: unknown
        onProgress: unknown
      }
      expect(args.members.map((m) => m.id)).toEqual(["p-one", "p-two"])
      expect(args.isInstalled("p-one")).toBe(false)
      expect(typeof args.install).toBe("function")
      expect(typeof args.onProgress).toBe("function")
      await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith("presets.resultInstalled"))
    })

    it("toasts the cancelled, all-skipped, and failed result branches", async () => {
      githubSourcePresets.push(preset("acme/repo:bundle", ["p-one"]))
      render(<PluginMarketplace />)
      act(() => usePluginsStore.getState().setDiscoverOrigin("workspace"))
      const installBtn = await screen.findByTestId("preset-install-acme/repo:bundle")

      runPresetInstallMock.mockResolvedValueOnce(result({ cancelled: ["p-one"] }))
      fireEvent.click(installBtn)
      await waitFor(() => expect(mockToast.message).toHaveBeenCalledWith("presets.resultCancelled"))

      runPresetInstallMock.mockResolvedValueOnce(result({ skipped: ["p-one"] }))
      fireEvent.click(installBtn)
      await waitFor(() =>
        expect(mockToast.message).toHaveBeenCalledWith("presets.resultAllSkipped")
      )

      runPresetInstallMock.mockResolvedValueOnce(
        result({ failed: [{ id: "p-one", name: "P One", message: "sha mismatch" }] })
      )
      fireEvent.click(installBtn)
      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("presets.resultFailed"))
    })

    it("toasts the partial-success branch", async () => {
      githubSourcePresets.push(preset("acme/repo:bundle", ["p-one", "p-two"]))
      runPresetInstallMock.mockResolvedValue(
        result({
          installed: ["p-one"],
          failed: [{ id: "p-two", name: "P Two", message: "denied" }],
        })
      )
      render(<PluginMarketplace />)
      act(() => usePluginsStore.getState().setDiscoverOrigin("workspace"))
      fireEvent.click(await screen.findByTestId("preset-install-acme/repo:bundle"))
      await waitFor(() => expect(mockToast.warning).toHaveBeenCalledWith("presets.resultPartial"))
    })

    it("gates preset installs on the desktop host", async () => {
      // Not a once-return: card renders consume the gate too, so the override
      // must still hold when the click reaches it.
      mockCanUseTauriInvoke.mockReturnValue(false)
      githubSourcePresets.push(preset("acme/repo:bundle", ["p-one"]))
      render(<PluginMarketplace />)
      act(() => usePluginsStore.getState().setDiscoverOrigin("workspace"))
      fireEvent.click(await screen.findByTestId("preset-install-acme/repo:bundle"))
      expect(mockToast.error).toHaveBeenCalledWith("presets.desktopOnly")
      expect(runPresetInstallMock).not.toHaveBeenCalled()
      mockCanUseTauriInvoke.mockReturnValue(true)
    })
  })
})
