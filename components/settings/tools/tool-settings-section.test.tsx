import { render, screen, fireEvent } from "@testing-library/react"

import { ToolSettingsSection } from "./tool-settings-section"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"

const setBuiltinToolEnabled = jest.fn()
const toggleAlwaysAllow = jest.fn()
const isTauriMock = jest.fn(() => true)

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && "name" in vars) return `${key}:${vars.name}`
    if (vars && "count" in vars) return `${key}:${vars.count}`
    if (vars && "tool" in vars) return `${key}:${vars.tool}`
    return key
  },
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const settingsState = {
  settings: {
    alwaysAllowTools: ["mcp__cognia-tools__git_status"],
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  },
  setBuiltinToolEnabled,
  toggleAlwaysAllow,
}

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(settingsState),
}))

describe("ToolSettingsSection", () => {
  beforeEach(() => {
    setBuiltinToolEnabled.mockClear()
    toggleAlwaysAllow.mockClear()
    isTauriMock.mockReturnValue(true)
  })

  it("renders all five categories", () => {
    render(<ToolSettingsSection />)
    expect(screen.getByText("fileExtras")).toBeInTheDocument()
    expect(screen.getByText("gitOperations")).toBeInTheDocument()
    expect(screen.getByText("processManagement")).toBeInTheDocument()
    expect(screen.getByText("environmentManagement")).toBeInTheDocument()
    expect(screen.getByText("shellExecution")).toBeInTheDocument()
  })

  it("calls setBuiltinToolEnabled when a switch is toggled", () => {
    render(<ToolSettingsSection />)
    const switches = screen.getAllByRole("switch")
    // Toggle the first switch (fileExtras): default is true → user clicks → false.
    fireEvent.click(switches[0])
    expect(setBuiltinToolEnabled).toHaveBeenCalled()
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

  it("disables switches in web mode", () => {
    isTauriMock.mockReturnValue(false)
    render(<ToolSettingsSection />)
    for (const sw of screen.getAllByRole("switch")) {
      expect(sw).toBeDisabled()
    }
  })

  it("renders the always-allow list", () => {
    render(<ToolSettingsSection />)
    expect(screen.getByText("mcp__cognia-tools__git_status")).toBeInTheDocument()
  })
})
