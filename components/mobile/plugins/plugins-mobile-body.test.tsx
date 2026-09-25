/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// Every dialog host and section pane is exercised by its own suite. Stubbing
// them here keeps this file about the one thing the body owns: which section
// shows, and when the detail drawer opens.
jest.mock("@/components/plugins/plugin-permission-review", () => ({
  PluginPermissionReview: () => null,
}))
jest.mock("@/components/plugins/dialogs/plugin-delete-dialog-host", () => ({
  PluginDeleteDialogHost: () => null,
}))
jest.mock("@/components/plugins/dialogs/plugin-import-dialog", () => ({
  PluginImportDialog: () => null,
}))
jest.mock("@/components/plugins/dialogs/plugin-conflict-dialog", () => ({
  PluginConflictDialog: () => null,
}))
jest.mock("@/components/plugins/dialogs/plugin-update-dialog", () => ({
  PluginUpdateDialog: () => null,
}))
jest.mock("@/components/plugins/dialogs/plugin-rollback-dialog", () => ({
  PluginRollbackDialog: () => null,
}))
jest.mock("@/components/plugins/dialogs/plugin-filter-sheet", () => ({
  PluginFilterSheet: () => null,
}))
jest.mock("@/components/plugins/plugin-batch-actions-bar", () => ({
  // Renders its `className` rather than nothing: the offset this body hands the
  // bar is the whole reason the bar doesn't cover the tab bar, and a `() => null`
  // stub is exactly what let that regress unnoticed.
  PluginBatchActionsBar: ({ className }: { className?: string }) => (
    <div data-testid="stub-batch-bar" data-classname={className} />
  ),
}))
jest.mock("@/components/plugins/plugin-panel-toolbar", () => ({
  PluginPanelToolbar: ({
    onSyncRegistry,
    syncing,
  }: {
    onSyncRegistry?: () => void
    syncing?: boolean
  }) => (
    <div data-testid="stub-toolbar">
      <button
        type="button"
        data-testid="stub-toolbar-sync"
        disabled={!onSyncRegistry || syncing}
        onClick={() => onSyncRegistry?.()}
      >
        sync
      </button>
    </div>
  ),
}))

// Controllable URL, so the shared deep-link handling can be driven here.
let mockSearch = new URLSearchParams()
const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/plugins",
}))
jest.mock("@/components/plugins/plugin-section-pane", () => ({
  PluginSectionPane: ({ section }: { section: string }) => (
    <div data-testid={`stub-pane-${section}`} />
  ),
  PluginSectionControls: ({ section, layout }: { section: string; layout?: string }) => (
    <div data-testid={`stub-controls-${section}`} data-layout={layout} />
  ),
  pluginSectionHasControls: (section: string) =>
    section === "library" || section === "governance",
  useVisiblePluginSection: (section: string) => section,
}))
jest.mock("@/components/plugins/detail/plugin-detail-pane", () => ({
  PluginDetailPane: () => <div data-testid="stub-detail-pane" />,
}))

const mockIsMirrored = jest.fn(() => false)
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  isMirroredPluginClient: () => mockIsMirrored(),
}))

// `@/lib/platform/detect` is deliberately NOT mocked. `lib/tauri` calls
// `isTauri()` at module load (through `scroll-shadow-row` -> `lib/utils`), so a
// factory closing over a `const` mock hits the TDZ before the test body runs.
// jsdom answers false anyway, which is the browser-phone case this file is
// about. `visiblePluginSections` covers the desktop answer as a pure function.

const mockDevtoolsGate = jest.fn(() => false)
const mockRefresh = jest.fn(async () => {})
const mockSync = jest.fn(async () => {})
jest.mock("@/hooks/plugins", () => ({
  PluginsViewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDevtoolsGate: () => mockDevtoolsGate(),
  usePluginMarketplace: () => ({ refresh: mockRefresh }),
  usePluginRegistrySync: () => ({ syncing: false, sync: mockSync }),
  usePluginRow: (id: string) =>
    id ? { state: "ready", row: { id, name: `Plugin ${id}` } } : { state: "not-found" },
}))

import { act, fireEvent, render, screen } from "@testing-library/react"

import { usePluginsStore } from "@/stores/plugins"

import { COMPACT_ABOVE_TAB_BAR_BOTTOM } from "@/lib/shell/compact-shell"

import { PluginsMobileBody } from "./plugins-mobile-body"

beforeEach(() => {
  mockSearch = new URLSearchParams()
  mockReplace.mockClear()
  mockSync.mockClear()
  mockIsMirrored.mockReturnValue(false)
  mockDevtoolsGate.mockReturnValue(false)
  usePluginsStore.setState({ activeSection: "library", detailPluginId: null })
})

describe("PluginsMobileBody", () => {
  it("renders the active section's pane and its stacked controls", () => {
    render(<PluginsMobileBody />)
    expect(screen.getByTestId("plugins-mobile-body")).toBeInTheDocument()
    expect(screen.getByTestId("stub-pane-library")).toBeInTheDocument()
    expect(screen.getByTestId("stub-controls-library")).toHaveAttribute("data-layout", "stacked")
  })

  it("offers the same sections the desktop rail would, for this host", () => {
    render(<PluginsMobileBody />)
    expect(screen.getByTestId("plugins-mobile-section-library")).toBeInTheDocument()
    expect(screen.getByTestId("plugins-mobile-section-discover")).toBeInTheDocument()
    expect(screen.getByTestId("plugins-mobile-section-governance")).toBeInTheDocument()
    // A capability gap says so; an opt-in developer switch simply is not there.
    expect(screen.getByTestId("plugins-mobile-section-agent-packages")).toHaveAttribute(
      "data-disabled-reason",
      "desktop"
    )
    expect(screen.getByTestId("plugins-mobile-section-agent-packages")).toBeDisabled()
    expect(screen.queryByTestId("plugins-mobile-section-devtools")).toBeNull()
  })

  it("switches sections from the chip row", () => {
    render(<PluginsMobileBody />)
    fireEvent.click(screen.getByTestId("plugins-mobile-section-governance"))
    expect(usePluginsStore.getState().activeSection).toBe("governance")
  })

  /**
   * The defect this body exists to fix: on `FeaturePageShell`'s mobile branch
   * the right pane was an UNCONTROLLED Sheet, so selecting a plugin only wrote
   * the store and nothing appeared.
   */
  it("opens the detail drawer when the selection changes", () => {
    render(<PluginsMobileBody />)
    expect(screen.queryByTestId("stub-detail-pane")).toBeNull()
    act(() => usePluginsStore.getState().openDetail("web-tools"))
    expect(screen.getByTestId("stub-detail-pane")).toBeInTheDocument()
  })

  /**
   * Selection survives navigation because it is what the desktop pane reopens
   * on, so an already-set id must NOT pop the drawer on arrival.
   */
  it("stays shut when a selection is already set on mount", () => {
    usePluginsStore.setState({ detailPluginId: "web-tools" })
    render(<PluginsMobileBody />)
    expect(screen.queryByTestId("stub-detail-pane")).toBeNull()
  })

  it("clears the selection on close so the same row can be reopened", () => {
    render(<PluginsMobileBody />)
    act(() => usePluginsStore.getState().openDetail("web-tools"))
    const surface =
      screen.queryByTestId("responsive-detail-sheet") ??
      screen.getByTestId("responsive-detail-drawer")
    fireEvent.keyDown(surface, { key: "Escape" })
    expect(usePluginsStore.getState().detailPluginId).toBeNull()
    expect(screen.queryByTestId("stub-detail-pane")).toBeNull()

    // Reopening the same plugin is a change again, so the drawer comes back.
    act(() => usePluginsStore.getState().openDetail("web-tools"))
    expect(screen.getByTestId("stub-detail-pane")).toBeInTheDocument()
  })

  it("says a queued toggle is queued, but only on a mirrored client", () => {
    const { unmount } = render(<PluginsMobileBody />)
    expect(screen.queryByTestId("plugins-mobile-mirrored-hint")).toBeNull()
    unmount()

    mockIsMirrored.mockReturnValue(true)
    render(<PluginsMobileBody />)
    expect(screen.getByTestId("plugins-mobile-mirrored-hint")).toBeInTheDocument()
  })

  // The Library toolbar's Sync button was permanently disabled here (no
  // handler was passed), while a second header button did the same job. One
  // refresh per section now: the toolbar's on the Library, the header's on
  // every other section.
  it("syncs the registry from the Library toolbar, with no duplicate header button", () => {
    render(<PluginsMobileBody />)
    expect(screen.queryByTestId("plugins-mobile-refresh")).toBeNull()
    const sync = screen.getByTestId("stub-toolbar-sync")
    expect(sync).not.toBeDisabled()
    fireEvent.click(sync)
    expect(mockSync).toHaveBeenCalled()
  })

  it("refreshes the catalog from the header button off the Library", () => {
    usePluginsStore.setState({ activeSection: "governance" })
    render(<PluginsMobileBody />)
    const refresh = screen.getByTestId("plugins-mobile-refresh")
    expect(refresh).toHaveClass("size-9")
    fireEvent.click(refresh)
    expect(mockSync).toHaveBeenCalled()
  })

  // `/me/plugins` mounts this under `SubPageShell`, which owns the title and
  // back arrow. Dropping our header must not drop the refresh with it.
  it("keeps refresh reachable when the host supplies the header", () => {
    usePluginsStore.setState({ activeSection: "discover" })
    render(<PluginsMobileBody showHeader={false} />)
    expect(screen.queryByRole("heading", { name: "title" })).toBeNull()
    fireEvent.click(screen.getByTestId("plugins-mobile-refresh"))
    expect(mockSync).toHaveBeenCalled()
  })

  // ⌘K results and "View details" toasts link `/plugins?plugin=<id>`. The phone
  // body ignored every URL param, so the link landed on a bare list.
  it("opens the detail drawer for a ?plugin= deep link and strips the param", () => {
    usePluginsStore.setState({ activeSection: "discover" })
    mockSearch = new URLSearchParams("plugin=web-tools")
    render(<PluginsMobileBody />)
    expect(usePluginsStore.getState().activeSection).toBe("library")
    expect(usePluginsStore.getState().detailPluginId).toBe("web-tools")
    expect(screen.getByTestId("stub-detail-pane")).toBeInTheDocument()
    expect(mockReplace).toHaveBeenCalledWith("/plugins", { scroll: false })
  })

  it("applies ?section= but not to a section this shell disables", () => {
    mockSearch = new URLSearchParams("section=agent-packages")
    render(<PluginsMobileBody />)
    expect(usePluginsStore.getState().activeSection).toBe("library")
  })

  // The detail header already opens with the name; titling the drawer with it
  // too printed the name twice, one line apart.
  it("titles the drawer with the section label, not the plugin name", () => {
    render(<PluginsMobileBody />)
    act(() => usePluginsStore.getState().openDetail("web-tools"))
    expect(screen.queryByText("Plugin web-tools")).toBeNull()
    expect(screen.getByText("detailSheetLabel")).toBeInTheDocument()
    expect(screen.getByTestId("plugins-mobile-detail-body")).toHaveClass(
      "h-[70dvh]",
      "pb-[env(safe-area-inset-bottom)]"
    )
  })

  /**
   * Both routes that mount this body — `/plugins` and `/me/plugins` — keep
   * `MobileTabBar` on screen (neither is in `TAB_BAR_HIDDEN_PREFIXES`, neither
   * is a `/workflows/` sub-route). The bar's own default offset clears the
   * safe area only, which parks it inside the tab bar's band, so the lift has
   * to come from here.
   */
  it("lifts the batch actions bar above the compact shell's tab bar", () => {
    render(<PluginsMobileBody />)
    expect(screen.getByTestId("stub-batch-bar")).toHaveAttribute(
      "data-classname",
      COMPACT_ABOVE_TAB_BAR_BOTTOM
    )
  })

  it("lifts it on the `/me/plugins` mount too, which also keeps the tab bar", () => {
    render(<PluginsMobileBody showHeader={false} />)
    expect(screen.getByTestId("stub-batch-bar")).toHaveAttribute(
      "data-classname",
      COMPACT_ABOVE_TAB_BAR_BOTTOM
    )
  })
})
