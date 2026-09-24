/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    if (vars && typeof vars.message === "string") return `${key}:${vars.message}`
    return key
  },
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}))

// Stateful next/navigation mock so the URL re-sync tests can swap the URL
// between renders.
let mockSearchString = ""
let mockSearchCacheKey = ""
let mockSearchCacheValue = new URLSearchParams("")
const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn() }),
  usePathname: () => "/plugins",
  useSearchParams: () => {
    if (mockSearchString !== mockSearchCacheKey) {
      mockSearchCacheKey = mockSearchString
      mockSearchCacheValue = new URLSearchParams(mockSearchString)
    }
    return mockSearchCacheValue
  },
}))

const baseRow: PluginRow = {
  id: "plugin_x",
  name: "Test Plugin",
  version: "1.2.3",
  status: "enabled",
  source: "builtin",
  type: "frontend",
  enabled: true,
  capabilities: ["tools"],
  path: "builtin://x",
  manifest: { id: "plugin_x", permissions: ["clipboard:read"] },
  createdAt: 1,
  updatedAt: 1,
}

/** A VS Code extension row — installed from Open VSX, not cognia's registry. */
const vscodeRow: PluginRow = {
  ...baseRow,
  id: "esbenp.prettier-vscode",
  name: "Prettier",
  source: "marketplace",
  type: "vscode-extension",
  path: "/ext/esbenp.prettier-vscode",
  manifest: {
    id: "esbenp.prettier-vscode",
    vscodeExtension: { identifier: "esbenp.prettier-vscode", source: "openvsx" },
  },
}

const mockRows: PluginRow[] = [baseRow]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockRows)),
  setPluginEnabled: jest.fn(),
  deletePlugin: jest.fn(),
  getPlugin: jest.fn(() => Promise.resolve(mockRows[0])),
  updatePlugin: jest.fn(async () => undefined),
}))

jest.mock("@/lib/plugin/bridge/scheduled-task-bridge", () => ({
  unregisterScheduledTasksForPlugin: jest.fn(async () => 0),
}))

// The cognia registry client behind the "Sync Registry" button.
jest.mock("@/lib/plugin/package/marketplace", () => ({
  getPluginMarketplace: jest.fn(() => ({
    checkForUpdates: jest.fn(async () => []),
  })),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}))

const useDeveloperModeMock = jest.fn(() => true)
jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  useDeveloperMode: () => useDeveloperModeMock(),
}))

// The cascade-uninstall spies live inside the factory (jest.mock factories
// hit the TDZ for outer consts) and are re-exported so the test can assert
// the two table deletes actually fired.
jest.mock("@/lib/db/schema", () => {
  const deletePermissions = jest.fn(async () => undefined)
  const deleteAnalytics = jest.fn(async () => undefined)
  const db = {
    pluginAnalytics: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
      where: () => ({ equals: () => ({ delete: deleteAnalytics }) }),
    },
    pluginPermissions: {
      where: () => ({ equals: () => ({ delete: deletePermissions }) }),
    },
    // The marketplace-sources hook writes each catalog fetch's outcome back to
    // its row, so this stub has to cover the table too.
    pluginMarketplaceSources: {
      get: async () => undefined,
      put: async () => undefined,
      orderBy: () => ({ toArray: async () => [] }),
      delete: async () => undefined,
    },
  }
  return {
    getDb: () => db,
    __deletePermissions: deletePermissions,
    __deleteAnalytics: deleteAnalytics,
  }
})

// FeaturePageShell already has its own tests — stub it to a transparent
// composition wrapper so this test focuses on PluginPanel's wiring (which
// section / which detail content is mounted). The right pane's overlay-Sheet
// contract (`open` / `onOpenChange`, used below `lg`) is surfaced as a data
// attribute plus the two ways the real Sheet reports a change: its trigger and
// its dismiss.
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    header,
    leftPane,
    rightPane,
    children,
  }: {
    header?: React.ReactNode
    leftPane?: { content: React.ReactNode }
    rightPane?: {
      content: React.ReactNode
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }
    children: React.ReactNode
  }) => (
    <div data-testid="feature-page-shell">
      <div data-testid="shell-header">{header}</div>
      <div data-testid="shell-left">{leftPane?.content}</div>
      <div data-testid="shell-center">{children}</div>
      <div
        data-testid="shell-right"
        data-sheet-open={rightPane?.open === undefined ? "uncontrolled" : String(rightPane.open)}
      >
        {rightPane?.content}
      </div>
      <button type="button" onClick={() => rightPane?.onOpenChange?.(true)}>
        stub-open-right-sheet
      </button>
      <button type="button" onClick={() => rightPane?.onOpenChange?.(false)}>
        stub-dismiss-right-sheet
      </button>
    </div>
  ),
}))

jest.mock("./devtools/plugin-devtools-pane", () => ({
  PluginDevtoolsPane: () => <div data-testid="plugin-devtools-pane" />,
}))

// The detail pane has its own suite. Here it only has to say which plugin it
// is showing, so the sheet tests can tell "opened on the right plugin" apart
// from "opened on the empty state".
jest.mock("./detail/plugin-detail-pane", () => ({
  PluginDetailPane: () => {
    const { usePluginsStore: store } = jest.requireActual("@/stores/plugins")
    const id = store((s: { detailPluginId: string | null }) => s.detailPluginId)
    return <div data-testid="plugin-detail-pane-stub">{id ?? "empty"}</div>
  },
}))

import { PluginPanel } from "./plugin-panel"
import { getPluginMarketplace } from "@/lib/plugin/package/marketplace"
import { deletePlugin, updatePlugin } from "@/lib/db/plugins"
import { unregisterScheduledTasksForPlugin } from "@/lib/plugin/bridge/scheduled-task-bridge"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"
import { toast } from "sonner"
import * as dbSchema from "@/lib/db/schema"

const getPluginMarketplaceMock = getPluginMarketplace as unknown as jest.Mock
const { __deletePermissions: deletePermissionsMock, __deleteAnalytics: deleteAnalyticsMock } =
  dbSchema as unknown as { __deletePermissions: jest.Mock; __deleteAnalytics: jest.Mock }

beforeEach(() => {
  mockRows.length = 0
  mockRows.push(baseRow)
  mockSearchString = ""
  mockSearchCacheKey = ""
  mockSearchCacheValue = new URLSearchParams("")
  mockReplace.mockClear()
  jest.mocked(deletePlugin).mockClear()
  jest.mocked(updatePlugin).mockClear()
  jest.mocked(unregisterScheduledTasksForPlugin).mockClear()
  jest.mocked(toast.success).mockClear()
  jest.mocked(toast.error).mockClear()
  deletePermissionsMock.mockClear()
  deleteAnalyticsMock.mockClear()
  getPluginMarketplaceMock.mockReturnValue({ checkForUpdates: jest.fn(async () => []) })
  useDeveloperModeMock.mockReset()
  useDeveloperModeMock.mockReturnValue(true)
  usePluginsStore.setState({
    activeSection: "library",
    librarySubFilter: "all",
    governanceView: "permissions",
    detailSubTab: "overview",
    listViewMode: "list",
    filters: DEFAULT_PLUGIN_FILTERS,
    selection: new Set(),
    detailPluginId: null,
    filterSheetOpen: false,
    importStaging: null,
    deleteTarget: null,
    permissionReviewTarget: null,
    conflictDialogTarget: null,
    rollbackTarget: null,
  })
})

describe("PluginPanel (3-pane shell)", () => {
  it("mounts the FeaturePageShell with left nav, library center, and detail right", () => {
    render(<PluginPanel />)
    expect(screen.getByTestId("feature-page-shell")).toBeInTheDocument()
    // Left nav: PluginNavSidebar renders top-level section buttons.
    expect(screen.getByTestId("plugin-nav-library")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-nav-discover")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-nav-governance")).toBeInTheDocument()
    // Center: Library pane.
    expect(screen.getByTestId("plugin-library-pane")).toBeInTheDocument()
  })

  it("renders the active plugin row inside the library list center", () => {
    render(<PluginPanel />)
    expect(screen.getByText("Test Plugin")).toBeInTheDocument()
    expect(screen.getByText("v1.2.3")).toBeInTheDocument()
  })

  it("swaps the center pane to Discover when activeSection=discover", () => {
    usePluginsStore.setState({ activeSection: "discover" })
    render(<PluginPanel />)
    expect(screen.getByTestId("plugin-discover-pane")).toBeInTheDocument()
  })

  // The active section rides beside the title as a badge (`status` slot), not
  // as `context` text after the description — a trailing "· Library" read as
  // a stray fragment whenever the description truncated.
  it("shows the active section as a badge inside the page header", () => {
    render(<PluginPanel />)
    const header = screen.getByTestId("shell-header")
    expect(within(header).getByTestId("plugin-section-badge")).toHaveTextContent("library")
  })

  it("follows the active section when the section changes", () => {
    usePluginsStore.setState({ activeSection: "governance" })
    render(<PluginPanel />)
    const header = screen.getByTestId("shell-header")
    expect(within(header).getByTestId("plugin-section-badge")).toHaveTextContent("governance")
  })

  // Library / Discover / Governance are all 3-pane, so moving between them
  // never changes the pane count and never throws away the split the user
  // dragged. Governance's aggregate views are per-plugin, so the same
  // detail pane is the right right-pane content for them.
  it("keeps the detail pane mounted when activeSection=governance", () => {
    usePluginsStore.setState({ activeSection: "governance" })
    render(<PluginPanel />)
    expect(screen.getByTestId("plugin-governance-pane")).toBeInTheDocument()
    expect(screen.getByTestId("shell-right")).not.toBeEmptyDOMElement()
  })

  it("renders the governance view picker in the header, not the left rail", () => {
    usePluginsStore.setState({ activeSection: "governance" })
    render(<PluginPanel />)
    expect(screen.getByTestId("plugin-governance-view-audit")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-nav-governance-sub-audit")).not.toBeInTheDocument()
  })

  it("switches the governance view from the header segments", () => {
    usePluginsStore.setState({ activeSection: "governance", governanceView: "permissions" })
    render(<PluginPanel />)
    fireEvent.click(screen.getByTestId("plugin-governance-view-audit"))
    expect(usePluginsStore.getState().governanceView).toBe("audit")
  })

  it("uses the full workspace and hides plugin detail when activeSection=devtools", () => {
    usePluginsStore.setState({ activeSection: "devtools" })
    render(<PluginPanel />)

    expect(screen.getByTestId("plugin-devtools-pane")).toBeInTheDocument()
    expect(screen.getByTestId("shell-right")).toBeEmptyDOMElement()
  })

  it("redirects a disabled direct Devtools URL to Library and exposes the settings action", async () => {
    useDeveloperModeMock.mockReturnValue(false)
    mockSearchString = "section=devtools"

    render(<PluginPanel />)

    await waitFor(() => expect(usePluginsStore.getState().activeSection).toBe("library"))
    expect(mockReplace).toHaveBeenCalledWith("/plugins?section=library", { scroll: false })
    expect(toast.message).toHaveBeenCalledWith(
      "devtoolsDisabled.title",
      expect.objectContaining({ description: "devtoolsDisabled.description" })
    )
  })

  it("opens the rollback dialog when the store target is set", () => {
    usePluginsStore.setState({ rollbackTarget: "plugin_x" })
    render(<PluginPanel />)
    expect(screen.getAllByText(/title/).length).toBeGreaterThan(0)
  })

  it("removes real scheduler tasks before a direct uninstall", async () => {
    usePluginsStore.setState({
      deleteTarget: { pluginId: "plugin_x", name: "Test Plugin" },
    })
    render(<PluginPanel />)
    fireEvent.click(screen.getByRole("button", { name: "confirm" }))

    await waitFor(() => expect(unregisterScheduledTasksForPlugin).toHaveBeenCalledWith("plugin_x"))
    expect(deletePlugin).toHaveBeenCalledWith("plugin_x")
  })

  it("redirects a legacy ?tab=browse deep link to the canonical ?section=discover URL", () => {
    mockSearchString = "tab=browse"
    render(<PluginPanel />)
    expect(mockReplace).toHaveBeenCalledWith("/plugins?section=discover", { scroll: false })
  })

  it("redirects ?tab=configure to the configurable library + configure subtab", () => {
    mockSearchString = "tab=configure"
    render(<PluginPanel />)
    expect(mockReplace).toHaveBeenCalledWith(
      "/plugins?section=library&sub=configurable&subtab=configure",
      { scroll: false }
    )
  })

  it("hydrates new ?section=governance&gov=audit into the store on mount", () => {
    mockSearchString = "section=governance&gov=audit"
    render(<PluginPanel />)
    expect(usePluginsStore.getState().activeSection).toBe("governance")
    expect(usePluginsStore.getState().governanceView).toBe("audit")
  })

  it("re-syncs section when ?section= changes after mount", () => {
    mockSearchString = "section=library"
    const { rerender } = render(<PluginPanel />)
    expect(usePluginsStore.getState().activeSection).toBe("library")

    mockSearchString = "section=discover"
    rerender(<PluginPanel />)
    expect(usePluginsStore.getState().activeSection).toBe("discover")
  })

  it("does not redirect for an unknown ?tab= value", () => {
    mockSearchString = "tab=garbage"
    render(<PluginPanel />)
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("ignores unknown ?section= values without overriding the current section", () => {
    mockSearchString = "section=library"
    const { rerender } = render(<PluginPanel />)
    expect(usePluginsStore.getState().activeSection).toBe("library")

    mockSearchString = "section=garbage"
    rerender(<PluginPanel />)
    expect(usePluginsStore.getState().activeSection).toBe("library")
  })

  it("Sync Registry never sends VS Code extension ids to the cognia registry", async () => {
    // Same leak as the one fixed in lifecycle/updater.ts, on a second path:
    // this button hands every installed row to the *marketplace's* own
    // checkForUpdates, which loops getPlugin(id) against cognia's registry.
    // An Open VSX id there tells cognia's registry what the user has
    // installed, and can never return an answer.
    // The parameter is typed so `mock.calls[0][0]` is reachable — an untyped
    // `jest.fn(async () => [])` infers a zero-length tuple and won't compile.
    const checkForUpdates = jest.fn(
      async (_installed: Array<{ id: string; version: string }>) => []
    )
    getPluginMarketplaceMock.mockReturnValue({ checkForUpdates })
    mockRows.push(vscodeRow)

    render(<PluginPanel />)
    fireEvent.click(screen.getByLabelText("syncRegistryAria"))

    await waitFor(() => expect(checkForUpdates).toHaveBeenCalled())
    const sentIds = checkForUpdates.mock.calls[0][0].map((p) => p.id)
    expect(sentIds).not.toContain("esbenp.prettier-vscode")
    // ...while ordinary cognia plugins are still checked as before.
    expect(sentIds).toEqual(["plugin_x"])
  })

  it("Sync Registry stamps manifest.updateAvailable on rows the catalog reports as stale", async () => {
    getPluginMarketplaceMock.mockReturnValue({
      checkForUpdates: jest.fn(async () => [{ id: "plugin_x", latestVersion: "2.0.0" }]),
    })

    render(<PluginPanel />)
    fireEvent.click(screen.getByLabelText("syncRegistryAria"))

    await waitFor(() => expect(jest.mocked(updatePlugin)).toHaveBeenCalled())
    expect(jest.mocked(updatePlugin)).toHaveBeenCalledWith("plugin_x", {
      manifest: { ...baseRow.manifest, updateAvailable: true },
    })
  })

  it("Sync Registry leaves rows alone when the flag already matches the catalog", async () => {
    // wantsFlag === currentFlag → no write. Without this branch every sync
    // would rewrite all 40 manifests and churn the Dexie table.
    getPluginMarketplaceMock.mockReturnValue({ checkForUpdates: jest.fn(async () => []) })

    render(<PluginPanel />)
    fireEvent.click(screen.getByLabelText("syncRegistryAria"))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(jest.mocked(updatePlugin)).not.toHaveBeenCalled()
  })

  it("Sync Registry surfaces a toast when the registry throws", async () => {
    // The toolbar fires this handler with `void`, so a rejection here would
    // otherwise be an unhandled promise plus a spinner stuck on forever.
    getPluginMarketplaceMock.mockReturnValue({
      checkForUpdates: jest.fn(async () => {
        throw new Error("registry down")
      }),
    })

    render(<PluginPanel />)
    fireEvent.click(screen.getByLabelText("syncRegistryAria"))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(jest.mocked(toast.error).mock.calls[0][0]).toContain("registry down")
    // The spinner has to clear even on the failure path.
    expect(screen.getByLabelText("syncRegistryAria")).not.toBeDisabled()
  })

  it("cascade uninstall also drops the plugin's permissions and analytics rows", async () => {
    usePluginsStore.setState({
      deleteTarget: { pluginId: "plugin_x", name: "Test Plugin" },
    })
    render(<PluginPanel />)
    fireEvent.click(screen.getByRole("checkbox", { name: /cascade/i }))
    fireEvent.click(screen.getByRole("button", { name: "confirm" }))

    await waitFor(() => expect(jest.mocked(deletePlugin)).toHaveBeenCalledWith("plugin_x"))
    expect(deletePermissionsMock).toHaveBeenCalled()
    expect(deleteAnalyticsMock).toHaveBeenCalled()
  })

  it("plain uninstall leaves permissions and analytics rows in place", async () => {
    usePluginsStore.setState({
      deleteTarget: { pluginId: "plugin_x", name: "Test Plugin" },
    })
    render(<PluginPanel />)
    fireEvent.click(screen.getByRole("button", { name: "confirm" }))

    await waitFor(() => expect(jest.mocked(deletePlugin)).toHaveBeenCalledWith("plugin_x"))
    expect(deletePermissionsMock).not.toHaveBeenCalled()
    expect(deleteAnalyticsMock).not.toHaveBeenCalled()
  })
})

// Below `lg` the shell renders the detail pane as an overlay Sheet. It used to
// be uncontrolled, so a click on a plugin's name only wrote the store and the
// row "did nothing". These pin that the selection drives the sheet.
describe("PluginPanel detail sheet (overlay tier)", () => {
  const sheet = () => screen.getByTestId("shell-right")

  it("controls the right pane's sheet instead of leaving it uncontrolled", () => {
    render(<PluginPanel />)
    expect(sheet()).toHaveAttribute("data-sheet-open", "false")
  })

  it("opens the detail when the plugin name is clicked", async () => {
    const user = userEvent.setup()
    render(<PluginPanel />)
    await user.click(screen.getByTestId("plugin-library-row-plugin_x"))
    expect(usePluginsStore.getState().detailPluginId).toBe("plugin_x")
    expect(sheet()).toHaveAttribute("data-sheet-open", "true")
    expect(screen.getByTestId("plugin-detail-pane-stub")).toHaveTextContent("plugin_x")
  })

  it("opens the detail from the keyboard (Enter on the focused name)", async () => {
    const user = userEvent.setup()
    render(<PluginPanel />)
    screen.getByTestId("plugin-library-row-plugin_x").focus()
    await user.keyboard("{Enter}")
    expect(usePluginsStore.getState().detailPluginId).toBe("plugin_x")
    expect(sheet()).toHaveAttribute("data-sheet-open", "true")
  })

  it("opens the same detail surface from the row menu's Open details", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<PluginPanel />)
    await user.click(screen.getByRole("button", { name: "actionsMenuAria:Test Plugin" }))
    await user.click(await screen.findByRole("menuitem", { name: "openDetails" }))
    expect(usePluginsStore.getState().detailPluginId).toBe("plugin_x")
    expect(sheet()).toHaveAttribute("data-sheet-open", "true")
  })

  it("dismissing the sheet clears the selection so the same name reopens it", async () => {
    const user = userEvent.setup()
    render(<PluginPanel />)
    await user.click(screen.getByTestId("plugin-library-row-plugin_x"))
    await user.click(screen.getByRole("button", { name: "stub-dismiss-right-sheet" }))
    expect(sheet()).toHaveAttribute("data-sheet-open", "false")
    expect(usePluginsStore.getState().detailPluginId).toBeNull()

    await user.click(screen.getByTestId("plugin-library-row-plugin_x"))
    expect(sheet()).toHaveAttribute("data-sheet-open", "true")
  })

  it("does not pop the sheet for a selection that survived navigation", () => {
    usePluginsStore.setState({ detailPluginId: "plugin_x" })
    render(<PluginPanel />)
    expect(sheet()).toHaveAttribute("data-sheet-open", "false")
  })

  it("lets the pane's own trigger open the sheet with no selection", async () => {
    const user = userEvent.setup()
    render(<PluginPanel />)
    await user.click(screen.getByRole("button", { name: "stub-open-right-sheet" }))
    expect(sheet()).toHaveAttribute("data-sheet-open", "true")
    expect(usePluginsStore.getState().detailPluginId).toBeNull()
  })
})
