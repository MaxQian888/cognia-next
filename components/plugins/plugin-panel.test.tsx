/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}))

const mockRows: PluginRow[] = [
  {
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
  },
]

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRows,
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => Promise.resolve(mockRows)),
  setPluginEnabled: jest.fn(),
  deletePlugin: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    pluginAnalytics: {
      orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }),
    },
    pluginScheduledJobs: {
      orderBy: () => ({ toArray: async () => [] }),
      where: () => ({ equals: () => ({ delete: async () => undefined }) }),
    },
    pluginPermissions: {
      where: () => ({ equals: () => ({ delete: async () => undefined }) }),
    },
  }),
}))

import { PluginPanel } from "./plugin-panel"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

beforeEach(() => {
  usePluginsStore.setState({
    activeTab: "installed",
    filters: DEFAULT_PLUGIN_FILTERS,
    selection: new Set(),
    detailPluginId: null,
    filterSheetOpen: false,
    configTarget: null,
    importStaging: null,
    deleteTarget: null,
    permissionReviewTarget: null,
    conflictDialogTarget: null,
    rollbackTarget: null,
  })
})

describe("PluginPanel", () => {
  it("renders all 7 tab triggers", () => {
    render(<PluginPanel />)
    // PluginPanelTabs uses `useTranslations("plugins.tabs")` so the mocked
    // translator returns the bare tab id as the rendered label.
    for (const id of [
      "installed",
      "browse",
      "configure",
      "permissions",
      "scheduled",
      "analytics",
      "devtools",
    ]) {
      expect(screen.getAllByRole("tab", { name: new RegExp(id) }).length).toBeGreaterThan(0)
    }
  })

  it("installed tab renders plugin row from mocked data", () => {
    render(<PluginPanel />)
    expect(screen.getByText("Test Plugin")).toBeInTheDocument()
    expect(screen.getByText("v1.2.3")).toBeInTheDocument()
  })

  it("default activeTab is installed (from store)", () => {
    render(<PluginPanel />)
    const installedTrigger = screen
      .getAllByRole("tab", { name: /installed/ })
      .find((el) => el.getAttribute("data-state") === "active")
    expect(installedTrigger).toBeDefined()
  })

  it("scheduled tab links to settings scheduled-tasks section", () => {
    usePluginsStore.setState({ activeTab: "scheduled" })
    render(<PluginPanel />)
    // PluginScheduledJobs renders an "openScheduler" link in its empty state.
    const link = screen.getByText("openScheduler").closest("a")
    expect(link).toHaveAttribute("href", "/settings?section=scheduled-tasks")
  })

  it("devtools tab shows the gate hint outside development", () => {
    usePluginsStore.setState({ activeTab: "devtools" })
    render(<PluginPanel />)
    // PluginDevtoolsPanel renders the gate hint when isDeveloperMode is false.
    expect(screen.getByText(/gateHint/)).toBeInTheDocument()
  })

  it("opens the rollback dialog when the store target is set", () => {
    usePluginsStore.setState({ rollbackTarget: "plugin_x" })
    render(<PluginPanel />)
    // PluginRollbackDialog renders its Dialog title via `plugins.rollback.title`.
    expect(screen.getAllByText(/title/).length).toBeGreaterThan(0)
  })
})
