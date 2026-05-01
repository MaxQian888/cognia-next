import { render, screen, fireEvent } from "@testing-library/react"

import { AlwaysAllowList } from "./always-allow-list"

const toggleAlwaysAllow = jest.fn()
const stateRef = {
  current: { alwaysAllowTools: [] as string[] },
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && "tool" in vars) return `${key}:${vars.tool}`
    return key
  },
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: stateRef.current,
      toggleAlwaysAllow: (...args: unknown[]) => toggleAlwaysAllow(...args),
    }),
}))

describe("AlwaysAllowList", () => {
  beforeEach(() => {
    toggleAlwaysAllow.mockClear()
    stateRef.current = {
      alwaysAllowTools: ["mcp__cognia-tools__file_hash", "Bash"],
    }
  })

  it("renders both tool names", () => {
    render(<AlwaysAllowList />)
    expect(screen.getByText("mcp__cognia-tools__file_hash")).toBeInTheDocument()
    expect(screen.getByText("Bash")).toBeInTheDocument()
  })

  it("invokes toggleAlwaysAllow(tool, false) on remove", () => {
    render(<AlwaysAllowList />)
    fireEvent.click(screen.getByLabelText("alwaysAllowRemove:Bash"))
    expect(toggleAlwaysAllow).toHaveBeenCalledWith("Bash", false)
  })

  it("renders a placeholder when the list is empty", () => {
    stateRef.current = { alwaysAllowTools: [] }
    render(<AlwaysAllowList />)
    expect(screen.getByText("alwaysAllowEmpty")).toBeInTheDocument()
  })

  it("falls back to an empty list when settings is null", () => {
    stateRef.current = null as unknown as { alwaysAllowTools: string[] }
    render(<AlwaysAllowList />)
    expect(screen.getByText("alwaysAllowEmpty")).toBeInTheDocument()
  })
})
