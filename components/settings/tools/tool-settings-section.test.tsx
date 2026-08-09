import { render, screen, fireEvent } from "@testing-library/react"

import { ToolSettingsSection } from "./tool-settings-section"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

const setBuiltinToolEnabled = jest.fn()
const setWebToolsEnabled = jest.fn()
const setWebToolsNativeOnAnthropic = jest.fn()
const setWebToolsAllowPrivateHosts = jest.fn()
const setWebToolsAlwaysDistill = jest.fn()
const setSkillToolEnabled = jest.fn()
const setSlashCommandToolEnabled = jest.fn()
const setTeamCollaborationToolEnabled = jest.fn()
const setVectorToolEnabled = jest.fn()
const setSpawnTaskToolEnabled = jest.fn()
const setSessionMessagingToolEnabled = jest.fn()
const toggleAlwaysAllow = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && "name" in vars) return `${key}:${vars.name}`
    if (vars && "count" in vars) return `${key}:${vars.count}`
    if (vars && "tool" in vars) return `${key}:${vars.tool}`
    return key
  },
}))

// `jest.mock` factories are hoisted above the imports, so they run before any
// top-level `const` is initialised. `@/lib/tauri` is pulled in transitively by
// the store chain at import time, which means a factory closing over an
// outer-scope `const` would hit a temporal-dead-zone ReferenceError. Define the
// mock inside the factory and reach it back via `require`.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isTauri: isTauriMock } = require("@/lib/tauri") as { isTauri: jest.Mock }

const settingsState = {
  settings: {
    alwaysAllowTools: ["mcp__cognia-tools__git_status"],
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    webTools: { enabled: true } as { enabled: boolean; nativeOnAnthropic?: boolean },
  },
  setBuiltinToolEnabled,
  setWebToolsEnabled,
  setWebToolsNativeOnAnthropic,
  setWebToolsAllowPrivateHosts,
  setWebToolsAlwaysDistill,
  setSkillToolEnabled,
  setSlashCommandToolEnabled,
  setTeamCollaborationToolEnabled,
  setVectorToolEnabled,
  setSpawnTaskToolEnabled,
  setSessionMessagingToolEnabled,
  toggleAlwaysAllow,
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(settingsState),
}))

describe("ToolSettingsSection", () => {
  beforeEach(() => {
    setBuiltinToolEnabled.mockClear()
    setWebToolsEnabled.mockClear()
    setWebToolsNativeOnAnthropic.mockClear()
    setWebToolsAllowPrivateHosts.mockClear()
    setWebToolsAlwaysDistill.mockClear()
    setSkillToolEnabled.mockClear()
    setSlashCommandToolEnabled.mockClear()
    setTeamCollaborationToolEnabled.mockClear()
    setVectorToolEnabled.mockClear()
    setSpawnTaskToolEnabled.mockClear()
    setSessionMessagingToolEnabled.mockClear()
    toggleAlwaysAllow.mockClear()
    isTauriMock.mockReturnValue(true)
    settingsState.settings.webTools = { enabled: true }
  })

  it("renders all built-in tool categories", () => {
    render(<ToolSettingsSection />)
    expect(screen.getByText("fileExtras")).toBeInTheDocument()
    expect(screen.getByText("gitOperations")).toBeInTheDocument()
    expect(screen.getByText("processManagement")).toBeInTheDocument()
    expect(screen.getByText("environmentManagement")).toBeInTheDocument()
    expect(screen.getByText("shellExecution")).toBeInTheDocument()
    expect(screen.getByText("terminalRepl")).toBeInTheDocument()
    expect(screen.getByText("lspIntelligence")).toBeInTheDocument()
  })

  it("calls setBuiltinToolEnabled when a category switch is toggled", () => {
    render(<ToolSettingsSection />)
    // Query by label rather than index so the web-card sub-toggles don't shift it.
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:fileExtras"))
    expect(setBuiltinToolEnabled).toHaveBeenCalled()
  })

  it("toggles the always-distill and allow-private web sub-toggles", () => {
    render(<ToolSettingsSection />)
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:webAlwaysDistillTitle"))
    expect(setWebToolsAlwaysDistill).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:webAllowPrivateTitle"))
    expect(setWebToolsAllowPrivateHosts).toHaveBeenCalledWith(true)
  })

  it("hides the web sub-toggles when web tools are disabled", () => {
    settingsState.settings.webTools = { enabled: false }
    render(<ToolSettingsSection />)
    expect(screen.queryByText("webAlwaysDistillTitle")).not.toBeInTheDocument()
    expect(screen.queryByText("webAllowPrivateTitle")).not.toBeInTheDocument()
  })

  it("toggles Skill, SlashCommand, spawn-task, session-messaging, and team tools", () => {
    render(<ToolSettingsSection />)
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:skillToolTitle"))
    expect(setSkillToolEnabled).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:slashToolTitle"))
    expect(setSlashCommandToolEnabled).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:spawnTaskToolTitle"))
    expect(setSpawnTaskToolEnabled).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:sessionMessagingToolTitle"))
    expect(setSessionMessagingToolEnabled).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:teamCollabToolTitle"))
    expect(setTeamCollaborationToolEnabled).toHaveBeenCalledWith(true)
  })

  it("keeps the self-invocation card available off-desktop (host-routed)", () => {
    isTauriMock.mockReturnValue(false)
    render(<ToolSettingsSection />)
    expect(screen.getByLabelText("toggleAriaLabel:skillToolTitle")).not.toBeDisabled()
    expect(screen.getByLabelText("toggleAriaLabel:slashToolTitle")).not.toBeDisabled()
    expect(screen.getByLabelText("toggleAriaLabel:spawnTaskToolTitle")).not.toBeDisabled()
  })

  it("toggles the vector-memory tools", () => {
    render(<ToolSettingsSection />)
    fireEvent.click(screen.getByLabelText("toggleAriaLabel:vectorToolTitle"))
    expect(setVectorToolEnabled).toHaveBeenCalledWith(true)
  })

  it("disables the vector-memory toggle off-desktop and says why", () => {
    isTauriMock.mockReturnValue(false)
    render(<ToolSettingsSection />)
    expect(screen.getByLabelText("toggleAriaLabel:vectorToolTitle")).toBeDisabled()
    expect(screen.getByText("vectorToolDesktopOnly")).toBeInTheDocument()
    expect(screen.queryByText("vectorToolDesc")).not.toBeInTheDocument()
  })

  it("describes the vector-memory tools on desktop", () => {
    render(<ToolSettingsSection />)
    expect(screen.getByText("vectorToolDesc")).toBeInTheDocument()
    expect(screen.getByLabelText("toggleAriaLabel:vectorToolTitle")).not.toBeDisabled()
  })

  it("calls setWebToolsNativeOnAnthropic when the native sub-toggle is flipped", () => {
    render(<ToolSettingsSection />)
    const switches = screen.getAllByRole("switch")
    fireEvent.click(switches[1])
    expect(setWebToolsNativeOnAnthropic).toHaveBeenCalledWith(true)
  })

  it("reflects the native sub-toggle's checked state", () => {
    settingsState.settings.webTools = { enabled: true, nativeOnAnthropic: true }
    render(<ToolSettingsSection />)
    expect(screen.getAllByRole("switch")[1]).toBeChecked()
  })

  it("hides the native sub-toggle in web mode", () => {
    isTauriMock.mockReturnValue(false)
    render(<ToolSettingsSection />)
    expect(screen.queryByText("webNativeAnthropicTitle")).not.toBeInTheDocument()
  })

  it("hides the native sub-toggle when web tools are disabled", () => {
    settingsState.settings.webTools = { enabled: false }
    render(<ToolSettingsSection />)
    expect(screen.queryByText("webNativeAnthropicTitle")).not.toBeInTheDocument()
  })

  it("calls setWebToolsEnabled when the Web card switch is toggled", () => {
    render(<ToolSettingsSection />)
    const webSwitch = screen.getAllByRole("switch")[0]
    fireEvent.click(webSwitch)
    expect(setWebToolsEnabled).toHaveBeenCalledWith(false)
  })

  it("expand/collapse reveals the tool badges", () => {
    render(<ToolSettingsSection />)
    // showTools button exists for enabled categories.
    const buttons = screen.getAllByRole("button", { name: /^showTools/ })
    expect(buttons.length).toBeGreaterThan(0)
    // Click first one — fileExtras has many tools.
    fireEvent.click(buttons[0])
    expect(screen.getByText("file_hash")).toBeInTheDocument()
  })

  it("shows the desktop-required banner in web mode", () => {
    isTauriMock.mockReturnValue(false)
    render(<ToolSettingsSection />)
    expect(screen.getByText("desktopRequired")).toBeInTheDocument()
  })

  it("disables sidecar category switches in web mode but keeps the Web card enabled", () => {
    isTauriMock.mockReturnValue(false)
    render(<ToolSettingsSection />)
    // Off-desktop the native sub-toggle is hidden. Host-routed switches (web
    // card enable + its always-distill/allow-private sub-toggles + the three
    // self-invoke tools) stay enabled; only the sidecar categories are disabled.
    const hostRouted = [
      "toggleAriaLabel:webCardTitle",
      "toggleAriaLabel:webAlwaysDistillTitle",
      "toggleAriaLabel:webAllowPrivateTitle",
      "toggleAriaLabel:skillToolTitle",
      "toggleAriaLabel:slashToolTitle",
      "toggleAriaLabel:teamCollabToolTitle",
    ]
    for (const label of hostRouted) {
      expect(screen.getByLabelText(label)).not.toBeDisabled()
    }
    // Sidecar category switches are disabled off-desktop.
    expect(screen.getByLabelText("toggleAriaLabel:fileExtras")).toBeDisabled()
    expect(screen.getByLabelText("toggleAriaLabel:gitOperations")).toBeDisabled()
  })

  it("renders the always-allow list", () => {
    render(<ToolSettingsSection />)
    expect(screen.getByText("mcp__cognia-tools__git_status")).toBeInTheDocument()
  })
})
