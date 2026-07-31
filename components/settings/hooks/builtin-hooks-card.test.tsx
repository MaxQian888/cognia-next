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

// The switch list is collapsed by default; expand it before touching switches.
function expand() {
  fireEvent.click(screen.getByTestId("builtin-hooks-toggle"))
}

describe("BuiltinHooksCard", () => {
  it("renders a switch for every built-in hook reflecting defaultEnabled", async () => {
    render(<BuiltinHooksCard />)
    await waitFor(() => {
      expect(screen.getByTestId("builtin-hooks-card")).toBeInTheDocument()
    })
    expand()
    for (const def of BUILTIN_HOOKS) {
      const sw = screen.getByTestId(`builtin-hook-switch-${def.id}`)
      // Radix Switch reflects checked via data-state / aria-checked
      const checked = sw.getAttribute("aria-checked") === "true"
      expect(checked).toBe(isBuiltinHookEnabled(def, {}))
    }
  })

  it("keeps the switch list collapsed until the header is toggled", async () => {
    render(<BuiltinHooksCard />)
    await waitFor(() => expect(screen.getByTestId("builtin-hooks-card")).toBeInTheDocument())
    expect(screen.queryByTestId("builtin-hook-switch-cost-quota-guard")).toBeNull()
    expand()
    expect(screen.getByTestId("builtin-hook-switch-cost-quota-guard")).toBeInTheDocument()
  })

  it("defaults to empty overrides when the user settings read returns null", async () => {
    mockReadUser.mockResolvedValue(null)
    render(<BuiltinHooksCard />)
    await waitFor(() =>
      expect(screen.getByTestId("builtin-hooks-card")).toHaveAttribute("data-loaded", "true")
    )
    expand()
    for (const def of BUILTIN_HOOKS) {
      const sw = screen.getByTestId(`builtin-hook-switch-${def.id}`)
      expect(sw.getAttribute("aria-checked") === "true").toBe(isBuiltinHookEnabled(def, {}))
    }
  })

  it("shows a summary badge with the enabled count", async () => {
    render(<BuiltinHooksCard />)
    await waitFor(() => expect(screen.getByTestId("builtin-hooks-card")).toBeInTheDocument())
    const enabled = BUILTIN_HOOKS.filter((d) => isBuiltinHookEnabled(d, {})).length
    expect(screen.getByText(`${enabled}/${BUILTIN_HOOKS.length}`)).toBeInTheDocument()
  })

  it("reflects existing builtinHookOverrides from user settings", async () => {
    mockReadUser.mockResolvedValue({ builtinHookOverrides: { "auto-context-loader": false } })
    render(<BuiltinHooksCard />)
    expand()
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
    expand()
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
    expand()
    const sw = await screen.findByTestId("builtin-hook-switch-pii-safety-guard")
    fireEvent.click(sw)
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})
