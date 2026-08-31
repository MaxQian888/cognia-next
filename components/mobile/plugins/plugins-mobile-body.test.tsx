/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
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
  PluginBatchActionsBar: () => null,
}))
jest.mock("@/components/plugins/plugin-panel-toolbar", () => ({
  PluginPanelToolbar: () => <div data-testid="stub-toolbar" />,
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

import { PluginsMobileBody } from "./plugins-mobile-body"

beforeEach(() => {
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
    // Desktop-only and devtools-gated sections are absent on a browser phone.
    expect(screen.queryByTestId("plugins-mobile-section-agent-packages")).toBeNull()
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

  it("refreshes the catalog from the header button", () => {
    render(<PluginsMobileBody />)
    fireEvent.click(screen.getByTestId("plugins-mobile-refresh"))
    expect(mockSync).toHaveBeenCalled()
  })

  // `/me/plugins` mounts this under `SubPageShell`, which owns the title and
  // back arrow. Dropping our header must not drop the refresh with it.
  it("keeps refresh reachable when the host supplies the header", () => {
    render(<PluginsMobileBody showHeader={false} />)
    expect(screen.queryByRole("heading", { name: "title" })).toBeNull()
    fireEvent.click(screen.getByTestId("plugins-mobile-refresh"))
    expect(mockSync).toHaveBeenCalled()
  })
})
