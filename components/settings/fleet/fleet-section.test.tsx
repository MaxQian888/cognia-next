/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FleetSection } from "./fleet-section"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

// The "Related" strip depends on the App Router (useRouter/useSearchParams);
// it's exercised in its own suite, so stub it out to keep this focused on the
// fleet controls.
jest.mock("@/components/settings/common/related-sections-strip", () => ({
  RelatedSectionsStrip: () => null,
  CLAUDE_CODE_RELATED: [],
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
  },
}))

const mockHooks = {
  installFleetHooks: jest.fn(),
  uninstallFleetHooks: jest.fn(),
  readFleetHooksStatus: jest.fn(),
}
jest.mock("@/lib/claude/hooks/fleet-hooks", () => ({
  installFleetHooks: () => mockHooks.installFleetHooks(),
  uninstallFleetHooks: () => mockHooks.uninstallFleetHooks(),
  readFleetHooksStatus: () => mockHooks.readFleetHooksStatus(),
}))

const mockFleet = {
  fleetMonitorStart: jest.fn(),
  fleetMonitorStop: jest.fn(),
  fleetMonitorStatus: jest.fn(),
  fleetCodexInstall: jest.fn(),
  fleetCodexUninstall: jest.fn(),
  fleetCodexStatus: jest.fn(),
  fleetCodexHooksInstall: jest.fn(),
  fleetCodexHooksUninstall: jest.fn(),
  fleetCodexHooksStatus: jest.fn(),
  fleetCodexHooksCapabilities: jest.fn(),
  fleetOpencodeInstall: jest.fn(),
  fleetOpencodeUninstall: jest.fn(),
  fleetOpencodeStatus: jest.fn(),
  fleetOpencodeOutboxStatus: jest.fn(),
  fleetOpencodeOutboxRepair: jest.fn(),
  openIslandWindow: jest.fn(),
  closeIslandWindow: jest.fn(),
  isIslandWindowOpen: jest.fn(),
  islandListMonitors: jest.fn(),
  islandSetMonitor: jest.fn(),
  islandGetHideOnFullscreen: jest.fn(),
  islandSetHideOnFullscreen: jest.fn(),
  islandDebugGeometry: jest.fn(),
}
jest.mock("@/lib/tauri/fleet", () => ({
  fleetMonitorStart: () => mockFleet.fleetMonitorStart(),
  fleetMonitorStop: () => mockFleet.fleetMonitorStop(),
  fleetMonitorStatus: () => mockFleet.fleetMonitorStatus(),
  fleetCodexInstall: () => mockFleet.fleetCodexInstall(),
  fleetCodexUninstall: () => mockFleet.fleetCodexUninstall(),
  fleetCodexStatus: () => mockFleet.fleetCodexStatus(),
  fleetCodexHooksInstall: () => mockFleet.fleetCodexHooksInstall(),
  fleetCodexHooksUninstall: () => mockFleet.fleetCodexHooksUninstall(),
  fleetCodexHooksStatus: () => mockFleet.fleetCodexHooksStatus(),
  fleetCodexHooksCapabilities: () => mockFleet.fleetCodexHooksCapabilities(),
  fleetOpencodeInstall: () => mockFleet.fleetOpencodeInstall(),
  fleetOpencodeUninstall: () => mockFleet.fleetOpencodeUninstall(),
  fleetOpencodeStatus: () => mockFleet.fleetOpencodeStatus(),
  fleetOpencodeOutboxStatus: () => mockFleet.fleetOpencodeOutboxStatus(),
  fleetOpencodeOutboxRepair: () => mockFleet.fleetOpencodeOutboxRepair(),
  openIslandWindow: () => mockFleet.openIslandWindow(),
  closeIslandWindow: () => mockFleet.closeIslandWindow(),
  isIslandWindowOpen: () => mockFleet.isIslandWindowOpen(),
  islandListMonitors: () => mockFleet.islandListMonitors(),
  islandSetMonitor: (name: string | null) => mockFleet.islandSetMonitor(name),
  islandGetHideOnFullscreen: () => mockFleet.islandGetHideOnFullscreen(),
  islandSetHideOnFullscreen: (hide: boolean) => mockFleet.islandSetHideOnFullscreen(hide),
  islandDebugGeometry: () => mockFleet.islandDebugGeometry(),
}))

// Radix Select can't be driven in jsdom (pointer-capture APIs missing); a
// native <select> stand-in keeps the value/onValueChange contract testable.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) => (
    <select
      data-testid="fleet-island-monitor-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))

const mockSubscribe = jest.fn()
jest.mock("@/lib/claude/settings", () => ({
  subscribeClaudeSettings: (...args: unknown[]) => mockSubscribe(...args),
}))

const mockFleetSnapshot = {
  sessions: [],
  hosts: [
    {
      hostRef: "device:worker-a",
      online: true,
      activeTurns: 1,
      maxActiveTurns: 2,
      lastSeenAt: 1,
      runtime: "codex",
      workspaceBindingRefs: ["repository:project:repo"],
    },
  ],
}
jest.mock("@/hooks/fleet/use-fleet-snapshot", () => ({
  useFleetSnapshot: () => ({ snapshot: mockFleetSnapshot, source: "companion" }),
}))
jest.mock("./execution-workers-card", () => ({
  ExecutionWorkersCard: ({ hosts }: { hosts: Array<{ hostRef: string }> }) => (
    <div data-testid="execution-workers-card">{hosts.map((host) => host.hostRef).join(",")}</div>
  ),
}))

function hooksStatus(
  install: "installed" | "partial" | "not-installed" | "unavailable",
  script: "installed" | "stale" | "missing" = "installed"
) {
  return {
    install,
    scripts: {
      claudeScript: script,
      claudeScriptPath: "/x/claude-hook.sh",
      monitorConfigPresent: true,
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSubscribe.mockResolvedValue(() => {})
  mockFleet.fleetMonitorStatus.mockResolvedValue({ enabled: false, port: null, configPath: null })
  mockFleet.fleetCodexStatus.mockResolvedValue({
    status: "not-installed",
    configPath: null,
    scriptPath: null,
  })
  mockFleet.fleetCodexUninstall.mockResolvedValue({
    status: "not-installed",
    configPath: null,
    scriptPath: null,
  })
  mockFleet.fleetCodexHooksStatus.mockResolvedValue("not-installed")
  mockFleet.fleetCodexHooksCapabilities.mockResolvedValue({
    state: "probed",
    ceilingEvents: ["SessionStart", "SessionEnd"],
    effectiveEvents: ["SessionStart", "SessionEnd"],
    diagnostic: null,
  })
  mockFleet.fleetCodexHooksInstall.mockResolvedValue("installed")
  mockFleet.fleetCodexHooksUninstall.mockResolvedValue("not-installed")
  mockFleet.fleetOpencodeStatus.mockResolvedValue({ status: "not-installed", pluginPath: null })
  mockFleet.fleetOpencodeOutboxStatus.mockResolvedValue({
    health: "healthy",
    path: "/tmp/outbox.json",
    error: null,
  })
  mockFleet.fleetOpencodeOutboxRepair.mockResolvedValue({
    health: "healthy",
    path: "/tmp/outbox.json",
    error: null,
  })
  mockFleet.isIslandWindowOpen.mockResolvedValue(false)
  mockFleet.islandListMonitors.mockResolvedValue([
    {
      name: "Built-in Display",
      index: 0,
      isPrimary: true,
      selected: false,
      width: 1512,
      height: 982,
    },
  ])
  mockFleet.islandSetMonitor.mockResolvedValue(true)
  mockFleet.islandGetHideOnFullscreen.mockResolvedValue(false)
  mockFleet.islandSetHideOnFullscreen.mockResolvedValue(true)
  mockHooks.readFleetHooksStatus.mockResolvedValue(hooksStatus("not-installed", "missing"))
})

// The controls are always visible on the dedicated section (no collapse), so
// loading is the only barrier to interaction.
async function renderLoaded() {
  const view = render(<FleetSection />)
  await waitFor(() => {
    expect(screen.getByTestId("fleet-section").getAttribute("data-loaded")).toBe("true")
  })
  return view
}

describe("FleetSection", () => {
  it("mounts worker management with hosts from the shared Fleet snapshot", async () => {
    await renderLoaded()
    expect(screen.getByTestId("execution-workers-card")).toHaveTextContent("device:worker-a")
  })

  it("renders the switches off for a fresh install", async () => {
    await renderLoaded()
    expect(screen.getByTestId("fleet-monitor-switch").getAttribute("aria-checked")).toBe("false")
    expect(screen.getByTestId("fleet-claude-switch").getAttribute("aria-checked")).toBe("false")
    expect(screen.getByTestId("fleet-island-switch").getAttribute("aria-checked")).toBe("false")
  })

  it("reflects a running monitor with its port", async () => {
    mockFleet.fleetMonitorStatus.mockResolvedValue({
      enabled: true,
      port: 7890,
      configPath: "/x/agent-monitor.json",
    })
    await renderLoaded()
    expect(screen.getByTestId("fleet-monitor-switch").getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText('monitor.running:{"port":7890}')).toBeInTheDocument()
  })

  it("starts the monitor on toggle and surfaces the result", async () => {
    mockFleet.fleetMonitorStart.mockResolvedValue({
      enabled: true,
      port: 7890,
      configPath: "/x",
    })
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-monitor-switch"))
    await waitFor(() => expect(mockFleet.fleetMonitorStart).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId("fleet-monitor-switch").getAttribute("aria-checked")).toBe("true")
    )
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("stops the monitor when toggled off", async () => {
    mockFleet.fleetMonitorStatus.mockResolvedValue({ enabled: true, port: 7890, configPath: "/x" })
    mockFleet.fleetMonitorStop.mockResolvedValue({ enabled: false, port: null, configPath: null })
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-monitor-switch"))
    await waitFor(() => expect(mockFleet.fleetMonitorStop).toHaveBeenCalled())
  })

  it("surfaces a failed monitor start as an error toast", async () => {
    mockFleet.fleetMonitorStart.mockResolvedValue(null)
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-monitor-switch"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByTestId("fleet-monitor-switch").getAttribute("aria-checked")).toBe("false")
  })

  it("installs Claude hooks on toggle and refreshes state", async () => {
    mockHooks.installFleetHooks.mockResolvedValue(hooksStatus("installed").scripts)
    mockHooks.readFleetHooksStatus
      .mockResolvedValueOnce(hooksStatus("not-installed", "missing"))
      .mockResolvedValue(hooksStatus("installed"))
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-claude-switch"))
    await waitFor(() => expect(mockHooks.installFleetHooks).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId("fleet-claude-switch").getAttribute("aria-checked")).toBe("true")
    )
    expect(screen.getByTestId("fleet-claude-badge-installed")).toBeInTheDocument()
  })

  it("uninstalls Claude hooks when toggled off", async () => {
    mockHooks.readFleetHooksStatus.mockResolvedValue(hooksStatus("installed"))
    mockHooks.uninstallFleetHooks.mockResolvedValue(hooksStatus("not-installed").scripts)
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-claude-switch"))
    await waitFor(() => expect(mockHooks.uninstallFleetHooks).toHaveBeenCalled())
  })

  it("disables the Claude switch and shows a badge when Claude Code is missing", async () => {
    mockHooks.readFleetHooksStatus.mockResolvedValue(hooksStatus("unavailable", "missing"))
    await renderLoaded()
    const sw = screen.getByTestId("fleet-claude-switch")
    expect(sw).toBeDisabled()
    expect(screen.getByTestId("fleet-claude-badge-unavailable")).toBeInTheDocument()
  })

  it("flags a stale (user-modified) hook script", async () => {
    mockHooks.readFleetHooksStatus.mockResolvedValue(hooksStatus("installed", "stale"))
    await renderLoaded()
    expect(screen.getByTestId("fleet-claude-badge-stale")).toBeInTheDocument()
  })

  it("shows a partial badge when only some hooks are installed", async () => {
    mockHooks.readFleetHooksStatus.mockResolvedValue(hooksStatus("partial"))
    await renderLoaded()
    expect(screen.getByTestId("fleet-claude-badge-partial")).toBeInTheDocument()
    expect(screen.getByTestId("fleet-claude-switch").getAttribute("aria-checked")).toBe("false")
  })

  it("still marks itself loaded when a status read throws", async () => {
    mockFleet.fleetMonitorStatus.mockRejectedValue(new Error("ipc down"))
    render(<FleetSection />)
    await waitFor(() =>
      expect(screen.getByTestId("fleet-section").getAttribute("data-loaded")).toBe("true")
    )
    // Fell back to defaults, no crash — the controls still render.
    expect(screen.getByTestId("fleet-monitor-switch").getAttribute("aria-checked")).toBe("false")
  })

  it("summarises active integrations in the header badge", async () => {
    mockFleet.fleetMonitorStatus.mockResolvedValue({ enabled: true, port: 7890, configPath: "/x" })
    render(<FleetSection />)
    await waitFor(() =>
      expect(screen.getByTestId("fleet-section").getAttribute("data-loaded")).toBe("true")
    )
    // Monitor enabled → one active integration; the badge (aria-labelled) shows it.
    expect(screen.getByLabelText('summaryAria:{"count":1}')).toBeInTheDocument()
  })

  it("surfaces a Claude hook install failure as an error toast", async () => {
    mockHooks.installFleetHooks.mockRejectedValue(new Error("settings write failed"))
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-claude-switch"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("installs and uninstalls the Codex hooks integration", async () => {
    mockFleet.fleetCodexHooksStatus
      .mockResolvedValueOnce("not-installed")
      .mockResolvedValue("installed")
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-codex-switch"))
    await waitFor(() => expect(mockFleet.fleetCodexHooksInstall).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId("fleet-codex-switch").getAttribute("aria-checked")).toBe("true")
    )
    expect(screen.getByTestId("fleet-codex-badge-installed")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("fleet-codex-switch"))
    await waitFor(() => expect(mockFleet.fleetCodexHooksUninstall).toHaveBeenCalled())
    // The retired `notify` installer is dormant by design (see the doc comment
    // on fleetCodexInstall) — no path through this card may reach it.
    expect(mockFleet.fleetCodexInstall).not.toHaveBeenCalled()
  })

  it("clears a leftover notify entry when hooks are installed", async () => {
    mockFleet.fleetCodexStatus.mockResolvedValue({
      status: "installed",
      configPath: "/c",
      scriptPath: "/s",
    })
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-codex-switch"))
    await waitFor(() => expect(mockFleet.fleetCodexHooksInstall).toHaveBeenCalled())
    await waitFor(() => expect(mockFleet.fleetCodexUninstall).toHaveBeenCalled())
  })

  it("leaves config.toml alone when no notify entry of ours is present", async () => {
    // The default beforeEach status is "not-installed" — the overwhelmingly
    // common case. Rewriting config.toml there would touch a file we have no
    // business in.
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-codex-switch"))
    await waitFor(() => expect(mockFleet.fleetCodexHooksInstall).toHaveBeenCalled())
    expect(mockFleet.fleetCodexUninstall).not.toHaveBeenCalled()
  })

  it("keeps the Codex switch actionable when the hook entry drifted", async () => {
    // Codex keys hook trust to the exact command, so a drifted entry never
    // fires. It must read as off and stay clickable — flipping it on rewrites
    // the entry, which is the only way to re-earn that trust.
    mockFleet.fleetCodexHooksStatus.mockResolvedValue("stale")
    await renderLoaded()
    const sw = screen.getByTestId("fleet-codex-switch")
    expect(sw).not.toBeDisabled()
    expect(sw.getAttribute("aria-checked")).toBe("false")
    expect(screen.getByTestId("fleet-codex-badge-codexStale")).toBeInTheDocument()
  })

  it("shows the trust hint only once a hook entry exists to be trusted", async () => {
    // Writing hooks.json is not enough — Codex will not fire a hook the user
    // has not approved in its TUI, and that approval is not readable from
    // disk. The card has to say so, or "Installed" reads as "working".
    mockFleet.fleetCodexHooksStatus.mockResolvedValue("not-installed")
    const { unmount } = await renderLoaded()
    expect(screen.queryByRole("note")).not.toBeInTheDocument()
    unmount()

    for (const status of ["installed", "stale"] as const) {
      mockFleet.fleetCodexHooksStatus.mockResolvedValue(status)
      const view = await renderLoaded()
      expect(screen.getByRole("note")).toBeInTheDocument()
      view.unmount()
    }
  })

  it("disables the Codex switch when Codex is not installed on the machine", async () => {
    mockFleet.fleetCodexHooksStatus.mockResolvedValue("unavailable")
    await renderLoaded()
    expect(screen.getByTestId("fleet-codex-switch")).toBeDisabled()
    expect(screen.getByTestId("fleet-codex-badge-codexUnavailable")).toBeInTheDocument()
  })

  it("surfaces a Codex hooks install failure as an error toast", async () => {
    mockFleet.fleetCodexHooksInstall.mockRejectedValue(new Error("hooks.json unwritable"))
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-codex-switch"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("installs and uninstalls the OpenCode plugin", async () => {
    mockFleet.fleetOpencodeInstall.mockResolvedValue({ status: "installed", pluginPath: "/p" })
    mockFleet.fleetOpencodeStatus
      .mockResolvedValueOnce({ status: "not-installed", pluginPath: null })
      .mockResolvedValue({ status: "installed", pluginPath: "/p" })
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-opencode-switch"))
    await waitFor(() => expect(mockFleet.fleetOpencodeInstall).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId("fleet-opencode-switch").getAttribute("aria-checked")).toBe("true")
    )
    expect(screen.getByTestId("fleet-opencode-badge-installed")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("fleet-opencode-switch"))
    await waitFor(() => expect(mockFleet.fleetOpencodeUninstall).toHaveBeenCalled())
  })

  it("disables the OpenCode switch when OpenCode is missing", async () => {
    mockFleet.fleetOpencodeStatus.mockResolvedValue({ status: "unavailable", pluginPath: null })
    await renderLoaded()
    expect(screen.getByTestId("fleet-opencode-switch")).toBeDisabled()
    expect(screen.getByTestId("fleet-opencode-badge-opencodeUnavailable")).toBeInTheDocument()
  })

  it("surfaces an OpenCode install failure as an error toast", async () => {
    mockFleet.fleetOpencodeInstall.mockRejectedValue(new Error("opencode missing"))
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-opencode-switch"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })

  it("opens and closes the island window", async () => {
    mockFleet.openIslandWindow.mockResolvedValue(true)
    mockFleet.closeIslandWindow.mockResolvedValue(true)
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-island-switch"))
    await waitFor(() => expect(mockFleet.openIslandWindow).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId("fleet-island-switch").getAttribute("aria-checked")).toBe("true")
    )
    fireEvent.click(screen.getByTestId("fleet-island-switch"))
    await waitFor(() => expect(mockFleet.closeIslandWindow).toHaveBeenCalled())
  })

  describe("hide under full-screen apps", () => {
    it("ships off, so the island floats over other apps' full-screen Spaces", async () => {
      await renderLoaded()
      expect(
        screen.getByTestId("fleet-island-fullscreen-switch").getAttribute("aria-checked")
      ).toBe("false")
    })

    it("reflects the persisted opt-in", async () => {
      mockFleet.islandGetHideOnFullscreen.mockResolvedValue(true)
      await renderLoaded()
      expect(
        screen.getByTestId("fleet-island-fullscreen-switch").getAttribute("aria-checked")
      ).toBe("true")
    })

    it("persists the opt-in and reports it saved", async () => {
      await renderLoaded()
      fireEvent.click(screen.getByTestId("fleet-island-fullscreen-switch"))
      await waitFor(() => expect(mockFleet.islandSetHideOnFullscreen).toHaveBeenCalledWith(true))
      await waitFor(() =>
        expect(
          screen.getByTestId("fleet-island-fullscreen-switch").getAttribute("aria-checked")
        ).toBe("true")
      )
      expect(toastSuccess).toHaveBeenCalled()
    })

    // The switch is optimistic so it doesn't lag the round-trip; a Rust refusal
    // has to take it back, or the UI would claim a preference that isn't stored.
    it("reverts the switch when Rust refuses the write", async () => {
      mockFleet.islandSetHideOnFullscreen.mockResolvedValue(false)
      await renderLoaded()
      fireEvent.click(screen.getByTestId("fleet-island-fullscreen-switch"))
      await waitFor(() => expect(mockFleet.islandSetHideOnFullscreen).toHaveBeenCalledWith(true))
      await waitFor(() =>
        expect(
          screen.getByTestId("fleet-island-fullscreen-switch").getAttribute("aria-checked")
        ).toBe("false")
      )
    })
  })

  it("hides the display picker with a single monitor", async () => {
    await renderLoaded()
    expect(screen.queryByTestId("fleet-island-monitor-row")).toBeNull()
  })

  it("persists a display choice and maps the primary sentinel back to null", async () => {
    mockFleet.islandListMonitors.mockResolvedValue([
      {
        name: "Built-in Display",
        index: 0,
        isPrimary: true,
        selected: false,
        width: 1512,
        height: 982,
      },
      {
        name: "DELL U2723QE",
        index: 1,
        isPrimary: false,
        selected: true,
        width: 2560,
        height: 1440,
      },
    ])
    await renderLoaded()

    // The persisted preference (selected: true) is reflected in the control.
    const select = screen.getByTestId("fleet-island-monitor-select") as HTMLSelectElement
    expect(select.value).toBe("DELL U2723QE")

    fireEvent.change(select, { target: { value: "Built-in Display" } })
    await waitFor(() => expect(mockFleet.islandSetMonitor).toHaveBeenCalledWith("Built-in Display"))
    // The section is busy until set + refresh settle; a change fired while busy
    // is intentionally swallowed, so wait for the control to re-enable.
    await waitFor(() => expect(select).not.toBeDisabled())

    fireEvent.change(select, { target: { value: "primary" } })
    await waitFor(() => expect(mockFleet.islandSetMonitor).toHaveBeenCalledWith(null))
  })

  describe("placement diagnostics", () => {
    const dump = {
      displays: [],
      preferredMonitor: null,
      windowPosition: null,
      windowSize: null,
      windowVisible: false,
      geometry: { topInset: 0, fullscreen: false },
    }

    it("copies the placement dump to the clipboard", async () => {
      const writeText = jest.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      mockFleet.islandDebugGeometry.mockResolvedValue(dump)

      await renderLoaded()
      fireEvent.click(screen.getByTestId("fleet-island-diagnostics-copy"))

      await waitFor(() => expect(writeText).toHaveBeenCalled())
      expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(dump)
      expect(toastSuccess).toHaveBeenCalled()
    })

    it("reports rather than copies when the backend has nothing (web build)", async () => {
      const writeText = jest.fn()
      Object.assign(navigator, { clipboard: { writeText } })
      mockFleet.islandDebugGeometry.mockResolvedValue(null)

      await renderLoaded()
      fireEvent.click(screen.getByTestId("fleet-island-diagnostics-copy"))

      await waitFor(() => expect(toastError).toHaveBeenCalled())
      expect(writeText).not.toHaveBeenCalled()
    })

    it("surfaces a clipboard rejection instead of claiming success", async () => {
      const writeText = jest.fn().mockRejectedValue(new Error("denied"))
      Object.assign(navigator, { clipboard: { writeText } })
      mockFleet.islandDebugGeometry.mockResolvedValue(dump)

      await renderLoaded()
      fireEvent.click(screen.getByTestId("fleet-island-diagnostics-copy"))

      await waitFor(() => expect(toastError).toHaveBeenCalled())
      expect(toastSuccess).not.toHaveBeenCalled()
    })
  })

  it("re-derives install state when settings.json changes externally", async () => {
    let notify: (() => void) | undefined
    mockSubscribe.mockImplementation(async (handler: () => void) => {
      notify = handler
      return () => {}
    })
    await renderLoaded()
    expect(mockHooks.readFleetHooksStatus).toHaveBeenCalledTimes(1)
    mockHooks.readFleetHooksStatus.mockResolvedValue(hooksStatus("installed"))
    notify?.()
    await waitFor(() =>
      expect(screen.getByTestId("fleet-claude-switch").getAttribute("aria-checked")).toBe("true")
    )
  })
})
