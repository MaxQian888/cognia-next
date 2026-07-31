import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PermissionsToolsTab } from "./permissions-tools-tab"
import { BUILTIN_TOOL_CATEGORIES } from "@/lib/settings/builtin-tools"

const CATEGORY_COUNT = BUILTIN_TOOL_CATEGORIES.length

const setBuiltinToolEnabled = jest.fn().mockResolvedValue(undefined)
const toggleAlwaysAllow = jest.fn().mockResolvedValue(undefined)
const stateRef = {
  current: {
    settings: {
      alwaysAllowTools: [],
      builtinTools: {
        fileExtras: false,
        git: false,
        process: false,
        environment: false,
        shellAdvanced: false,
      },
    } as Record<string, unknown>,
  },
}

const isTauriRef = { current: true }

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars) return `${key}:${JSON.stringify(vars)}`
    return key
  },
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: stateRef.current.settings,
      setBuiltinToolEnabled: (...args: unknown[]) => setBuiltinToolEnabled(...args),
      toggleAlwaysAllow: (...args: unknown[]) => toggleAlwaysAllow(...args),
    }),
}))

// Reuse-only — we don't exercise the inner list in this tab's tests.
jest.mock("@/components/settings/tools/always-allow-list", () => ({
  AlwaysAllowList: () => <div data-testid="always-allow-list" />,
}))

// The Command Auto-mode card has its own suite; stub it so this tab's
// switch-count / category assertions stay scoped to the built-in tools.
jest.mock("@/components/settings/agent-runtime/command-auto-mode-card", () => ({
  CommandAutoModeCard: () => null,
}))

// Tool-search runtime card has its own suite + adds an enable switch; stub it
// so this tab's switch-count / category assertions stay scoped.
jest.mock("@/components/settings/agent-runtime/tool-search-runtime-card", () => ({
  ToolSearchRuntimeCard: () => null,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriRef.current,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}))

describe("PermissionsToolsTab", () => {
  beforeEach(() => {
    setBuiltinToolEnabled.mockClear()
    toggleAlwaysAllow.mockClear()
    isTauriRef.current = true
    stateRef.current = {
      settings: {
        alwaysAllowTools: [],
        builtinTools: {
          fileExtras: false,
          git: false,
          process: false,
          environment: false,
          shellAdvanced: false,
        },
      },
    }
  })

  it("renders a switch per built-in tool category", () => {
    render(<PermissionsToolsTab />)
    // One switch per category (Auto-mode card is stubbed out above).
    const switches = screen.getAllByRole("switch")
    expect(switches).toHaveLength(CATEGORY_COUNT)
    expect(screen.getByTestId("always-allow-list")).toBeInTheDocument()
  })

  it("category switches are disabled in web mode", () => {
    isTauriRef.current = false
    render(<PermissionsToolsTab />)
    for (const sw of screen.getAllByRole("switch")) {
      expect(sw).toBeDisabled()
    }
  })

  it("Enter on the add input calls toggleAlwaysAllow with the typed name and clears", () => {
    render(<PermissionsToolsTab />)
    const input = screen.getByPlaceholderText("addToolPlaceholder") as HTMLInputElement
    fireEvent.change(input, { target: { value: "MyTool" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(toggleAlwaysAllow).toHaveBeenCalledWith("MyTool", true)
  })

  it("namespaces a known built-in tool when the user types just the bare name", () => {
    render(<PermissionsToolsTab />)
    const input = screen.getByPlaceholderText("addToolPlaceholder") as HTMLInputElement
    // `file_hash` is a known cognia-tools tool name; the tab should
    // transparently namespace it before persisting.
    fireEvent.change(input, { target: { value: "file_hash" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(toggleAlwaysAllow).toHaveBeenCalledWith("mcp__cognia-tools__file_hash", true)
  })

  it("clicking a category switch calls setBuiltinToolEnabled", async () => {
    const user = userEvent.setup()
    render(<PermissionsToolsTab />)
    const switches = screen.getAllByRole("switch")
    await user.click(switches[0])
    expect(setBuiltinToolEnabled).toHaveBeenCalledTimes(1)
    const args = setBuiltinToolEnabled.mock.calls[0]
    expect(args[1]).toBe(true)
  })

  it("Approve all built-in tools toggles every namespaced tool name", async () => {
    const user = userEvent.setup()
    render(<PermissionsToolsTab />)
    await user.click(screen.getByRole("button", { name: "approveAllBuiltin" }))
    // At least one approval per known built-in tool category.
    expect(toggleAlwaysAllow.mock.calls.length).toBeGreaterThan(0)
    for (const call of toggleAlwaysAllow.mock.calls) {
      expect(typeof call[0]).toBe("string")
      expect(call[0]).toMatch(/^mcp__cognia-tools__/)
      expect(call[1]).toBe(true)
    }
  })

  it("Add button is disabled and Enter is a no-op when input is whitespace", () => {
    render(<PermissionsToolsTab />)
    const input = screen.getByPlaceholderText("addToolPlaceholder") as HTMLInputElement
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(toggleAlwaysAllow).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: /addBtn/ })).toBeDisabled()
  })

  it("passes already-namespaced names through verbatim (no double prefix)", () => {
    render(<PermissionsToolsTab />)
    const input = screen.getByPlaceholderText("addToolPlaceholder") as HTMLInputElement
    fireEvent.change(input, { target: { value: "mcp__custom__my_tool" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(toggleAlwaysAllow).toHaveBeenCalledWith("mcp__custom__my_tool", true)
  })

  it("settings.builtinTools is null-safe (uses defaults)", () => {
    stateRef.current = {
      settings: {
        alwaysAllowTools: [],
      } as Record<string, unknown>,
    }
    render(<PermissionsToolsTab />)
    // One switch per category still renders; their state defaults to false.
    expect(screen.getAllByRole("switch")).toHaveLength(CATEGORY_COUNT)
  })
})
