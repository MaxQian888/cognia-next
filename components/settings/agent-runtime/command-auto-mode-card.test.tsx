import { fireEvent, render, screen } from "@testing-library/react"

import { CommandAutoModeCard } from "./command-auto-mode-card"

const save = jest.fn().mockResolvedValue(undefined)
const stateRef = { current: { settings: {} as Record<string, unknown> } }

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: stateRef.current.settings, save: (...a: unknown[]) => save(...a) }),
}))

// Radix Select is unreliable in jsdom — shim it with a native <select>.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => (
    <select data-testid="select" value={value} onChange={(e) => onValueChange(e.target.value)}>
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

function setSettings(s: Record<string, unknown>) {
  stateRef.current.settings = s
}

describe("CommandAutoModeCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setSettings({})
  })

  it("hides the configuration when Auto-mode is disabled", () => {
    render(<CommandAutoModeCard />)
    expect(screen.getByLabelText("enable")).toBeInTheDocument()
    expect(screen.queryByText("rulesTitle")).not.toBeInTheDocument()
  })

  it("enables Auto-mode through save()", () => {
    render(<CommandAutoModeCard />)
    fireEvent.click(screen.getByLabelText("enable"))
    expect(save).toHaveBeenCalledWith({
      agentPermissions: { autoApprove: { enabled: true } },
    })
  })

  it("reveals the rules editor and engine select when enabled", () => {
    setSettings({ agentPermissions: { autoApprove: { enabled: true } } })
    render(<CommandAutoModeCard />)
    expect(screen.getByText("rulesTitle")).toBeInTheDocument()
    expect(screen.getByText("noRules")).toBeInTheDocument()
  })

  it("only shows deny-high-risk in rules+model mode", () => {
    setSettings({ agentPermissions: { autoApprove: { enabled: true, mode: "rules" } } })
    const { rerender } = render(<CommandAutoModeCard />)
    expect(screen.queryByLabelText("denyHighRisk")).not.toBeInTheDocument()

    setSettings({ agentPermissions: { autoApprove: { enabled: true, mode: "rules+model" } } })
    rerender(<CommandAutoModeCard />)
    expect(screen.getByLabelText("denyHighRisk")).toBeInTheDocument()
  })

  it("adds a command rule via save()", () => {
    setSettings({ agentPermissions: { autoApprove: { enabled: true } } })
    render(<CommandAutoModeCard />)
    fireEvent.change(screen.getByLabelText("patternPlaceholder"), {
      target: { value: "git push*" },
    })
    fireEvent.click(screen.getByRole("button", { name: "addRule" }))
    expect(save).toHaveBeenCalledWith({
      agentPermissions: {
        autoApprove: { enabled: true },
        commandRules: { "git push*": "ask" },
      },
    })
  })

  it("switches the decision engine through save()", () => {
    setSettings({ agentPermissions: { autoApprove: { enabled: true } } })
    render(<CommandAutoModeCard />)
    // The engine select is the first shimmed <select> on the card.
    fireEvent.change(screen.getAllByTestId("select")[0], { target: { value: "rules+model" } })
    expect(save).toHaveBeenCalledWith({
      agentPermissions: { autoApprove: { enabled: true, mode: "rules+model" } },
    })
  })

  it("toggles deny-on-high-risk in rules+model mode", () => {
    setSettings({ agentPermissions: { autoApprove: { enabled: true, mode: "rules+model" } } })
    render(<CommandAutoModeCard />)
    fireEvent.click(screen.getByLabelText("denyHighRisk"))
    expect(save).toHaveBeenCalledWith({
      agentPermissions: {
        autoApprove: { enabled: true, mode: "rules+model", denyOnHighRisk: false },
      },
    })
  })

  it("adds a rule from the Enter key with the chosen verdict", () => {
    setSettings({ agentPermissions: { autoApprove: { enabled: true } } })
    render(<CommandAutoModeCard />)
    // Verdict select is the last shimmed <select>.
    const selects = screen.getAllByTestId("select")
    fireEvent.change(selects[selects.length - 1], { target: { value: "deny" } })
    const pattern = screen.getByLabelText("patternPlaceholder")
    fireEvent.change(pattern, { target: { value: "rm -rf*" } })
    fireEvent.keyDown(pattern, { key: "Enter" })
    expect(save).toHaveBeenCalledWith({
      agentPermissions: {
        autoApprove: { enabled: true },
        commandRules: { "rm -rf*": "deny" },
      },
    })
  })

  it("ignores Enter and the add button while the pattern is blank", () => {
    setSettings({ agentPermissions: { autoApprove: { enabled: true } } })
    render(<CommandAutoModeCard />)
    fireEvent.keyDown(screen.getByLabelText("patternPlaceholder"), { key: "Enter" })
    expect(save).not.toHaveBeenCalled()
  })

  it("removes an existing command rule", () => {
    setSettings({
      agentPermissions: {
        autoApprove: { enabled: true },
        commandRules: { "rm*": "deny" },
      },
    })
    render(<CommandAutoModeCard />)
    expect(screen.getByText("rm*")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("removeRule: rm*"))
    expect(save).toHaveBeenCalledWith({
      agentPermissions: { autoApprove: { enabled: true }, commandRules: {} },
    })
  })
})
