/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FleetMonitorCard } from "./fleet-monitor-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
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
  fleetOpencodeInstall: jest.fn(),
  fleetOpencodeUninstall: jest.fn(),
  fleetOpencodeStatus: jest.fn(),
  openIslandWindow: jest.fn(),
  closeIslandWindow: jest.fn(),
  isIslandWindowOpen: jest.fn(),
  islandListMonitors: jest.fn(),
  islandSetMonitor: jest.fn(),
}
jest.mock("@/lib/tauri/fleet", () => ({
  fleetMonitorStart: () => mockFleet.fleetMonitorStart(),
  fleetMonitorStop: () => mockFleet.fleetMonitorStop(),
  fleetMonitorStatus: () => mockFleet.fleetMonitorStatus(),
  fleetCodexInstall: () => mockFleet.fleetCodexInstall(),
  fleetCodexUninstall: () => mockFleet.fleetCodexUninstall(),
  fleetCodexStatus: () => mockFleet.fleetCodexStatus(),
  fleetOpencodeInstall: () => mockFleet.fleetOpencodeInstall(),
  fleetOpencodeUninstall: () => mockFleet.fleetOpencodeUninstall(),
  fleetOpencodeStatus: () => mockFleet.fleetOpencodeStatus(),
  openIslandWindow: () => mockFleet.openIslandWindow(),
  closeIslandWindow: () => mockFleet.closeIslandWindow(),
  isIslandWindowOpen: () => mockFleet.isIslandWindowOpen(),
  islandListMonitors: () => mockFleet.islandListMonitors(),
  islandSetMonitor: (name: string | null) => mockFleet.islandSetMonitor(name),
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
  mockFleet.fleetOpencodeStatus.mockResolvedValue({ status: "not-installed", pluginPath: null })
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
  mockHooks.readFleetHooksStatus.mockResolvedValue(hooksStatus("not-installed", "missing"))
})

async function renderLoaded() {
  render(<FleetMonitorCard />)
  await waitFor(() => {
    expect(screen.getByTestId("fleet-monitor-card").getAttribute("data-loaded")).toBe("true")
  })
  // The switches live in a collapsed body — expand it before interacting.
  fireEvent.click(screen.getByTestId("fleet-monitor-toggle"))
}

describe("FleetMonitorCard", () => {
  it("renders three switches off for a fresh install", async () => {
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
    render(<FleetMonitorCard />)
    await waitFor(() =>
      expect(screen.getByTestId("fleet-monitor-card").getAttribute("data-loaded")).toBe("true")
    )
    fireEvent.click(screen.getByTestId("fleet-monitor-toggle"))
    // Fell back to defaults, no crash.
    expect(screen.getByTestId("fleet-monitor-switch").getAttribute("aria-checked")).toBe("false")
  })

  it("keeps the controls collapsed until the header is toggled", async () => {
    render(<FleetMonitorCard />)
    await waitFor(() =>
      expect(screen.getByTestId("fleet-monitor-card").getAttribute("data-loaded")).toBe("true")
    )
    expect(screen.queryByTestId("fleet-monitor-switch")).toBeNull()
    fireEvent.click(screen.getByTestId("fleet-monitor-toggle"))
    expect(screen.getByTestId("fleet-monitor-switch")).toBeInTheDocument()
  })

  it("summarises active integrations in the header badge", async () => {
    mockFleet.fleetMonitorStatus.mockResolvedValue({ enabled: true, port: 7890, configPath: "/x" })
    render(<FleetMonitorCard />)
    await waitFor(() =>
      expect(screen.getByTestId("fleet-monitor-card").getAttribute("data-loaded")).toBe("true")
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

  it("installs and uninstalls the Codex notify integration", async () => {
    mockFleet.fleetCodexInstall.mockResolvedValue({ status: "installed" })
    mockFleet.fleetCodexStatus
      .mockResolvedValueOnce({ status: "not-installed", configPath: null, scriptPath: null })
      .mockResolvedValue({ status: "installed", configPath: "/c", scriptPath: "/s" })
    await renderLoaded()
    fireEvent.click(screen.getByTestId("fleet-codex-switch"))
    await waitFor(() => expect(mockFleet.fleetCodexInstall).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByTestId("fleet-codex-switch").getAttribute("aria-checked")).toBe("true")
    )
    expect(screen.getByTestId("fleet-codex-badge-installed")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("fleet-codex-switch"))
    await waitFor(() => expect(mockFleet.fleetCodexUninstall).toHaveBeenCalled())
  })

  it("disables the Codex switch and shows a conflict badge when notify is taken", async () => {
    mockFleet.fleetCodexStatus.mockResolvedValue({
      status: "conflict",
      configPath: "/c",
      scriptPath: "/s",
    })
    await renderLoaded()
    expect(screen.getByTestId("fleet-codex-switch")).toBeDisabled()
    expect(screen.getByTestId("fleet-codex-badge-codexConflict")).toBeInTheDocument()
  })

  it("surfaces a Codex install failure as an error toast", async () => {
    mockFleet.fleetCodexInstall.mockRejectedValue(new Error("notify taken"))
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
    // The card is busy until set + refresh settle; a change fired while busy
    // is intentionally swallowed, so wait for the control to re-enable.
    await waitFor(() => expect(select).not.toBeDisabled())

    fireEvent.change(select, { target: { value: "primary" } })
    await waitFor(() => expect(mockFleet.islandSetMonitor).toHaveBeenCalledWith(null))
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
