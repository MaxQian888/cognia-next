/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const setPluginEnabledForHostMock = jest.fn(async (_id: string, _enabled: boolean) => ({
  ok: true,
}))
const mockMirrored = jest.fn(() => false)
jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  setPluginEnabledForHost: (id: string, enabled: boolean) =>
    setPluginEnabledForHostMock(id, enabled),
  isMirroredPluginClient: () => mockMirrored(),
}))

const mockProfile = jest.fn(() => "tauri")
jest.mock("@/hooks/plugins/use-plugin-runtime-profile", () => ({
  usePluginRuntimeProfile: () => mockProfile(),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
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

jest.mock("@/hooks/plugins/use-plugin-rollback-availability", () => ({
  usePluginRollbackAvailable: () => false,
}))

import { toast } from "sonner"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
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
  jest.mocked(toast.message).mockClear()
  mockMirrored.mockReturnValue(false)
  mockProfile.mockReturnValue("tauri")
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
    expect(screen.getByText('versionLabel:{"version":"1.2.3"}')).toBeInTheDocument()
    expect(screen.getByText("An alpha plugin.")).toBeInTheDocument()
    // Asserting the testid, not the text: the intl mock echoes the key, so
    // `t("marketplace")` and the old raw `{plugin.source}` render identically
    // and a text assertion could not tell them apart.
    expect(screen.getByTestId("plugin-source-badge-marketplace")).toBeInTheDocument()
  })

  it("marks a dev build that is standing in front of the installed one", () => {
    usePluginStore.setState({
      plugins: {
        alpha: {
          manifest: { id: "alpha", name: "Alpha", version: "1.2.3", type: "frontend" },
          status: "enabled",
          source: "dev",
          path: "/p/alpha",
          config: {},
          descriptor: {
            identity: {
              canonicalId: "alpha",
              observedSources: ["marketplace", "dev"],
              activeSource: "dev",
            },
          },
        },
      },
    } as never)
    render(<PluginDetailHeader plugin={makePlugin({ source: "dev" })} />)
    expect(screen.getByTestId("plugin-source-badge-dev")).toHaveAttribute(
      "data-shadowing",
      "marketplace"
    )
  })

  it("flipping the enable toggle routes through the plugin manager, not a bare Dexie write", () => {
    // The toggle used to call `setPluginEnabled` directly, which flipped the
    // stored flag without ever running activate() — the plugin read as enabled
    // while its runtime had never started.
    render(<PluginDetailHeader plugin={makePlugin({ enabled: true })} />)
    fireEvent.click(screen.getByTestId("plugin-detail-enable-toggle"))
    expect(setPluginEnabledForHostMock).toHaveBeenCalledWith("alpha", false)
  })

  async function openMenu() {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    await user.click(screen.getByLabelText(/actionsMenuAria/))
    return user
  }

  it("labels the switch with its state, not only its colour", () => {
    const { rerender } = render(<PluginDetailHeader plugin={makePlugin({ enabled: true })} />)
    expect(screen.getByLabelText("enabledLabel")).toBe(
      screen.getByTestId("plugin-detail-enable-toggle")
    )
    rerender(<PluginDetailHeader plugin={makePlugin({ enabled: false })} />)
    expect(screen.getByLabelText("disabledLabel")).toBe(
      screen.getByTestId("plugin-detail-enable-toggle")
    )
  })

  it("offers Configure in the actions menu only when there is a config surface", async () => {
    const withSchema = makePlugin({
      manifest: {
        id: "alpha",
        configSchema: { type: "object", properties: { key: { type: "string" } } },
      },
    })
    const { unmount } = render(<PluginDetailHeader plugin={withSchema} />)
    const user = await openMenu()
    await user.click(await screen.findByText("configure"))
    expect(usePluginsStore.getState().detailSubTab).toBe("configure")
    unmount()

    render(<PluginDetailHeader plugin={makePlugin({ manifest: { id: "alpha" } })} />)
    await openMenu()
    await screen.findByTestId("plugin-detail-view-manifest")
    expect(screen.queryByText("configure")).not.toBeInTheDocument()
  })

  it("Review permissions opens the review dialog target", async () => {
    render(<PluginDetailHeader plugin={makePlugin()} />)
    const user = await openMenu()
    await user.click(await screen.findByText("reviewPermissions"))
    expect(usePluginsStore.getState().permissionReviewTarget).toEqual({ pluginId: "alpha" })
  })

  it("Uninstall from the menu sets the delete target with the display name", async () => {
    render(<PluginDetailHeader plugin={makePlugin()} />)
    const user = await openMenu()
    await user.click(await screen.findByTestId("plugin-row-uninstall"))
    expect(usePluginsStore.getState().deleteTarget).toEqual({
      pluginId: "alpha",
      name: "Alpha",
    })
  })

  it("View raw manifest switches the Overview tab to its manifest face", async () => {
    usePluginsStore.setState({ detailSubTab: "permissions", detailOverviewView: "info" })
    render(<PluginDetailHeader plugin={makePlugin()} />)
    const user = await openMenu()
    await user.click(await screen.findByTestId("plugin-detail-view-manifest"))
    expect(usePluginsStore.getState().detailSubTab).toBe("overview")
    expect(usePluginsStore.getState().detailOverviewView).toBe("manifest")
  })

  it("links to the log panel for a runtime with a log channel", async () => {
    render(<PluginDetailHeader plugin={makePlugin({ type: "frontend" })} />)
    await openMenu()
    const item = await screen.findByTestId("plugin-detail-open-logs")
    expect(item.tagName).toBe("A")
    expect(item.getAttribute("href")).toContain("q=alpha")
  })

  it("keeps the logs item for wasm, disabled, with the reason", async () => {
    render(<PluginDetailHeader plugin={makePlugin({ type: "wasm" })} />)
    await openMenu()
    const item = await screen.findByTestId("plugin-detail-open-logs")
    expect(item).toHaveAttribute("data-disabled")
    expect(item).toHaveTextContent("logs.missing.wasm-no-channel")
  })

  it("shows Update only when the marketplace has a newer version, scoped to this plugin", () => {
    const { rerender } = render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.queryByTestId("plugin-detail-update")).toBeNull()
    rerender(
      <PluginDetailHeader
        plugin={makePlugin({ manifest: { id: "alpha", updateAvailable: true } })}
      />
    )
    fireEvent.click(screen.getByTestId("plugin-detail-update"))
    expect(usePluginsStore.getState().updateDialog).toEqual({ pluginId: "alpha" })
  })

  it("keeps the top-right corner clear for a host-drawn close button", () => {
    const { rerender } = render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.getByTestId("plugin-detail-header")).not.toHaveClass("pr-11")
    rerender(<PluginDetailHeader plugin={makePlugin()} reserveCloseCorner />)
    expect(screen.getByTestId("plugin-detail-header")).toHaveClass("pr-11")
  })

  it("renders a close button only when the host passes onClose", () => {
    const onClose = jest.fn()
    const { rerender } = render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.queryByTestId("plugin-detail-close")).toBeNull()
    rerender(<PluginDetailHeader plugin={makePlugin()} onClose={onClose} />)
    fireEvent.click(screen.getByTestId("plugin-detail-close"))
    expect(onClose).toHaveBeenCalled()
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
    fireEvent.click(screen.getByTestId("plugin-detail-retry-cleanup"))
    await waitFor(() => expect(recoverPluginRuntimeMock).toHaveBeenCalledWith("alpha"))
  })

  it("hides the diagnostics summary when none are recorded", () => {
    mockDiagnostics = []
    render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.queryByTestId("plugin-detail-diagnostics-preview")).not.toBeInTheDocument()
  })

  it("collapses diagnostics to one summary line showing the newest message", () => {
    mockDiagnostics = [
      { code: "x", severity: "error", message: "first failure" },
      { code: "y", severity: "warning", message: "second issue" },
      { code: "z", severity: "warning", message: "third issue" },
    ]
    render(<PluginDetailHeader plugin={makePlugin()} />)
    const toggle = screen.getByTestId("plugin-detail-diagnostics-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle.textContent).toContain("third issue")
    const region = screen.getByTestId("plugin-detail-diagnostics-preview")
    expect(region.textContent).not.toContain("first failure")
  })

  it("expanding the diagnostics summary lists every entry, newest first", () => {
    mockDiagnostics = [
      { code: "x", severity: "error", message: "older entry", hint: "try again" },
      { code: "y", severity: "warning", message: "newer 1" },
      { code: "z", severity: "warning", message: "newer 2" },
    ]
    render(<PluginDetailHeader plugin={makePlugin()} />)
    fireEvent.click(screen.getByTestId("plugin-detail-diagnostics-toggle"))
    const items = screen.getAllByRole("listitem")
    expect(items.map((li) => li.textContent)).toEqual([
      "newer 2",
      "newer 1",
      "older entrytry again",
    ])
  })

  describe("enable gate", () => {
    const browserBlocked = makePlugin({
      enabled: false,
      manifest: {
        id: "alpha",
        runtimeCompatibility: {
          browser: { availability: "unsupported", reason: "Needs the desktop shell" },
        },
      },
    })

    it("disables Enable for a plugin this host cannot run and says why inline", () => {
      mockProfile.mockReturnValue("browser")
      render(<PluginDetailHeader plugin={browserBlocked} />)
      const toggle = screen.getByTestId("plugin-detail-enable-toggle")
      expect(toggle).toBeDisabled()
      const reason = screen.getByTestId("plugin-detail-enable-blocked")
      expect(reason).toHaveTextContent("blockedTooltip")
      expect(reason).toHaveTextContent("Needs the desktop shell")
      expect(toggle).toHaveAttribute("aria-describedby", reason.id)
    })

    it("still lets an enabled-but-incompatible plugin be switched off", () => {
      mockProfile.mockReturnValue("browser")
      render(<PluginDetailHeader plugin={{ ...browserBlocked, enabled: true }} />)
      const toggle = screen.getByTestId("plugin-detail-enable-toggle")
      expect(toggle).not.toBeDisabled()
      fireEvent.click(toggle)
      expect(setPluginEnabledForHostMock).toHaveBeenCalledWith("alpha", false)
    })

    it("judges a mirrored phone against the desktop and labels where it runs", () => {
      mockMirrored.mockReturnValue(true)
      mockProfile.mockReturnValue("mobile")
      render(<PluginDetailHeader plugin={browserBlocked} />)
      expect(screen.getByTestId("plugin-detail-enable-toggle")).not.toBeDisabled()
      expect(screen.queryByTestId("plugin-detail-enable-blocked")).toBeNull()
      expect(screen.getByTestId("plugin-detail-runs-on-desktop")).toHaveTextContent("runsOnDesktop")
    })
  })

  describe("uninstall gate", () => {
    it("disables Uninstall for a built-in plugin with the reason inline", async () => {
      render(<PluginDetailHeader plugin={makePlugin({ source: "builtin" })} />)
      await openMenu()
      const item = await screen.findByTestId("plugin-row-uninstall")
      expect(item).toHaveAttribute("data-disabled")
      expect(item).toHaveTextContent("uninstallBlocked.builtin")
    })

    it("disables Uninstall on a mirrored client with the reason inline", async () => {
      mockMirrored.mockReturnValue(true)
      render(<PluginDetailHeader plugin={makePlugin()} />)
      await openMenu()
      const item = await screen.findByTestId("plugin-row-uninstall")
      expect(item).toHaveAttribute("data-disabled")
      expect(item).toHaveTextContent("uninstallBlocked.mirrored")
    })
  })

  // The in-flow bar pushed the whole pane down whenever an activation
  // started. It is pinned to the header's bottom edge now.
  it("pins the activation bar out of the header's flow", () => {
    render(<PluginDetailHeader plugin={makePlugin()} />)
    expect(screen.getByTestId("plugin-detail-header")).toHaveClass("relative")
  })

  it("gives header actions a 40px target on a coarse pointer", () => {
    render(
      <PluginDetailHeader
        plugin={makePlugin({ manifest: { id: "alpha", updateAvailable: true } })}
        onClose={() => undefined}
      />
    )
    expect(screen.getByLabelText(/actionsMenuAria/)).toHaveClass("pointer-coarse:size-10")
    expect(screen.getByTestId("plugin-detail-update")).toHaveClass("pointer-coarse:h-10")
    expect(screen.getByTestId("plugin-detail-close")).toHaveClass("pointer-coarse:size-10")
  })
})
