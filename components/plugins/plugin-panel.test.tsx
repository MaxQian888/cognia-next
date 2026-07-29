/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
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

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginAnalytics: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
    },
    pluginPermissions: {
      where: () => ({ equals: () => ({ delete: async () => undefined }) }),
    },
    // The marketplace-sources hook writes each catalog fetch's outcome back to
    // its row, so this stub has to cover the table too.
    pluginMarketplaceSources: {
      get: async () => undefined,
      put: async () => undefined,
      orderBy: () => ({ toArray: async () => [] }),
      delete: async () => undefined,
    },
  }),
}))

// FeaturePageShell already has its own tests — stub it to a transparent
// composition wrapper so this test focuses on PluginPanel's wiring (which
// section / which detail content is mounted).
jest.mock("@/components/feature-shell/feature-page-shell", () => ({
  FeaturePageShell: ({
    toolbar,
    leftPane,
    rightPane,
    children,
  }: {
    toolbar?: React.ReactNode
    leftPane?: { content: React.ReactNode }
    rightPane?: { content: React.ReactNode }
    children: React.ReactNode
  }) => (
    <div data-testid="feature-page-shell">
      <div data-testid="shell-toolbar">{toolbar}</div>
      <div data-testid="shell-left">{leftPane?.content}</div>
      <div data-testid="shell-center">{children}</div>
      <div data-testid="shell-right">{rightPane?.content}</div>
    </div>
  ),
}))

import { PluginPanel } from "./plugin-panel"
import { getPluginMarketplace } from "@/lib/plugin/package/marketplace"
import { deletePlugin } from "@/lib/db/plugins"
import { unregisterScheduledTasksForPlugin } from "@/lib/plugin/bridge/scheduled-task-bridge"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

const getPluginMarketplaceMock = getPluginMarketplace as unknown as jest.Mock

beforeEach(() => {
  mockRows.length = 0
  mockRows.push(baseRow)
  mockSearchString = ""
  mockSearchCacheKey = ""
  mockSearchCacheValue = new URLSearchParams("")
  mockReplace.mockClear()
  jest.mocked(deletePlugin).mockClear()
  jest.mocked(unregisterScheduledTasksForPlugin).mockClear()
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

  it("swaps the center pane to Governance when activeSection=governance", () => {
    usePluginsStore.setState({ activeSection: "governance" })
    render(<PluginPanel />)
    expect(screen.getByTestId("plugin-governance-pane")).toBeInTheDocument()
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
})
