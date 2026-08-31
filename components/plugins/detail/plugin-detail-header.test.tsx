/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const setPluginEnabledForHostMock = jest.fn(async (_id: string, _enabled: boolean) => ({
  ok: true,
}))
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  setPluginEnabledForHost: (id: string, enabled: boolean) =>
    setPluginEnabledForHostMock(id, enabled),
}))

const recoverPluginRuntimeMock = jest.fn(async () => true)
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ recoverPluginRuntime: recoverPluginRuntimeMock }),
}))

let mockDiagnostics: ReadonlyArray<{
  code: string
  severity: "warning" | "error"
  message: string
  hint?: string
}> = []
jest.mock("@/hooks/plugins", () => ({
  usePluginDiagnostics: () => mockDiagnostics,
}))

import { PluginDetailHeader } from "./plugin-detail-header"
import { usePluginsStore } from "@/stores/plugins"

function makePlugin(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "alpha",
    name: "Alpha",
    version: "1.2.3",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/plugins/alpha",
    manifest: {
      id: "alpha",
      description: "An alpha plugin.",
      permissions: ["clipboard:read"],
      configSchema: { type: "object" },
    },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  setPluginEnabledForHostMock.mockClear()
  recoverPluginRuntimeMock.mockClear()
  mockDiagnostics = []
  usePluginsStore.setState({
    deleteTarget: null,
    permissionReviewTarget: null,
    detailPluginId: "alpha",
    detailSubTab: "overview",
  })
})

describe("PluginDetailHeader", () => {
  it("renders identity, description, status pill and source badge", () => {
    render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("v1.2.3")).toBeInTheDocument()
    expect(screen.getByText("An alpha plugin.")).toBeInTheDocument()
    expect(screen.getByText("marketplace")).toBeInTheDocument()
  })

  it("flipping the enable toggle routes through the plugin manager, not a bare Dexie write", () => {
    // The toggle used to call `setPluginEnabled` directly, which flipped the
    // stored flag without ever running activate() — the plugin read as enabled
    // while its runtime had never started.
    render(<PluginDetailHeader plugin={makePlugin({ enabled: true })} />)
    fireEvent.click(screen.getByTestId("plugin-detail-enable-toggle"))
    expect(setPluginEnabledForHostMock).toHaveBeenCalledWith("alpha", false)
  })

  it("Configure button only renders when the manifest declares a configSchema", () => {
    const { rerender } = render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.getByText("configure")).toBeInTheDocument()
    rerender(<PluginDetailHeader plugin={makePlugin({ manifest: { id: "alpha" } })} />)
    expect(screen.queryByText("configure")).not.toBeInTheDocument()
  })

  it("Review permissions button only renders when the manifest declares permissions", () => {
    render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.getByText("reviewPermissions")).toBeInTheDocument()
    fireEvent.click(screen.getByText("reviewPermissions"))
    expect(usePluginsStore.getState().permissionReviewTarget).toEqual({ pluginId: "alpha" })
  })

  it("clicking Configure routes the detail pane to the Configure sub-tab", () => {
    render(<PluginDetailHeader plugin={makePlugin()} />)
    fireEvent.click(screen.getByText("configure"))
    expect(usePluginsStore.getState().detailSubTab).toBe("configure")
  })

  it("clicking Uninstall sets the delete target", () => {
    render(<PluginDetailHeader plugin={makePlugin()} />)
    fireEvent.click(screen.getByText("uninstall"))
    expect(usePluginsStore.getState().deleteTarget).toEqual({
      pluginId: "alpha",
      name: "Alpha",
    })
  })

  it("surfaces dirty lifecycle state and retries authoritative cleanup", async () => {
    render(
      <PluginDetailHeader
        plugin={makePlugin({
          lifecycle: {
            intent: "enabled",
            actual: "dirty",
            revision: 3,
            updatedAt: 1,
          },
        })}
      />
    )
    expect(screen.getByText("lifecycle.dirty")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "lifecycle.retryCleanup" }))
    await waitFor(() => expect(recoverPluginRuntimeMock).toHaveBeenCalledWith("alpha"))
  })

  it("hides the diagnostics preview when none are recorded", () => {
    mockDiagnostics = []
    render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.queryByTestId("plugin-detail-diagnostics-preview")).not.toBeInTheDocument()
  })

  it("renders the diagnostics preview with the latest 2 entries inline", () => {
    mockDiagnostics = [
      { code: "x", severity: "error", message: "first failure" },
      { code: "y", severity: "warning", message: "second issue" },
      { code: "z", severity: "warning", message: "third issue" },
    ]
    render(<PluginDetailHeader plugin={makePlugin()} />)
    const region = screen.getByTestId("plugin-detail-diagnostics-preview")
    expect(region).toBeInTheDocument()
    // Latest two are displayed by default (reverse-chronological).
    expect(region.textContent).toContain("third issue")
    expect(region.textContent).toContain("second issue")
    expect(region.textContent).not.toContain("first failure")
  })

  it("expanding the diagnostics preview reveals the older entries", () => {
    mockDiagnostics = [
      { code: "x", severity: "error", message: "older entry" },
      { code: "y", severity: "warning", message: "newer 1" },
      { code: "z", severity: "warning", message: "newer 2" },
    ]
    render(<PluginDetailHeader plugin={makePlugin()} />)
    fireEvent.click(screen.getByText(/showMore/))
    const region = screen.getByTestId("plugin-detail-diagnostics-preview")
    expect(region.textContent).toContain("older entry")
  })
})
