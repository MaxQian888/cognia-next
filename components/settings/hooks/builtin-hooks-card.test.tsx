/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { BuiltinHooksCard } from "./builtin-hooks-card"
import { BUILTIN_HOOKS, isBuiltinHookEnabled } from "@/lib/claude/hooks/builtin-hooks"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockReadUser = jest.fn()
const mockWriteUser = jest.fn()
jest.mock("@/lib/claude/settings", () => ({
  readClaudeUserSettings: () => mockReadUser(),
  writeClaudeUserSettings: (p: unknown) => mockWriteUser(p),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
  },
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockReadUser.mockResolvedValue({})
  mockWriteUser.mockResolvedValue({ path: "/home/.claude/settings.json" })
})

describe("BuiltinHooksCard", () => {
  it("renders a switch for every built-in hook reflecting defaultEnabled", async () => {
    render(<BuiltinHooksCard />)
    await waitFor(() => {
      expect(screen.getByTestId("builtin-hooks-card")).toBeInTheDocument()
    })
    for (const def of BUILTIN_HOOKS) {
      const sw = screen.getByTestId(`builtin-hook-switch-${def.id}`)
      // Radix Switch reflects checked via data-state / aria-checked
      const checked = sw.getAttribute("aria-checked") === "true"
      expect(checked).toBe(isBuiltinHookEnabled(def, {}))
    }
  })

  it("reflects existing builtinHookOverrides from user settings", async () => {
    mockReadUser.mockResolvedValue({ builtinHookOverrides: { "auto-context-loader": false } })
    render(<BuiltinHooksCard />)
    await waitFor(() => {
      const sw = screen.getByTestId("builtin-hook-switch-auto-context-loader")
      expect(sw.getAttribute("aria-checked")).toBe("false")
    })
  })

  it("writes the override and round-trips the rest of the doc on toggle", async () => {
    mockReadUser.mockResolvedValue({ model: "claude-x", builtinHookOverrides: {} })
    render(<BuiltinHooksCard />)
    // Wait for the async load to settle so the toggle round-trips the full doc.
    await waitFor(() =>
      expect(screen.getByTestId("builtin-hooks-card")).toHaveAttribute("data-loaded", "true")
    )
    const sw = screen.getByTestId("builtin-hook-switch-cost-quota-guard")
    fireEvent.click(sw)
    await waitFor(() => expect(mockWriteUser).toHaveBeenCalledTimes(1))
    const payload = mockWriteUser.mock.calls[0][0]
    expect(payload.model).toBe("claude-x") // unrelated keys survive
    expect(payload.builtinHookOverrides["cost-quota-guard"]).toBe(true)
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("surfaces an error toast when the write fails", async () => {
    mockReadUser.mockResolvedValue({})
    mockWriteUser.mockRejectedValue(new Error("disk full"))
    render(<BuiltinHooksCard />)
    const sw = await screen.findByTestId("builtin-hook-switch-pii-safety-guard")
    fireEvent.click(sw)
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})
