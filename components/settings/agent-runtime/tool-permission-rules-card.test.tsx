import { fireEvent, render, screen } from "@testing-library/react"

import { ToolPermissionRulesCard } from "./tool-permission-rules-card"

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

describe("ToolPermissionRulesCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setSettings({})
  })

  it("shows the empty state when no rules exist", () => {
    render(<ToolPermissionRulesCard />)
    expect(screen.getByText("noRules")).toBeInTheDocument()
  })

  it("lists existing rules with tool + pattern + verdict", () => {
    setSettings({
      agentPermissions: {
        toolRules: { Bash: { "git *": "allow" }, write: { "**/*.env": "deny" } },
      },
    })
    render(<ToolPermissionRulesCard />)
    expect(screen.getByText("git *")).toBeInTheDocument()
    expect(screen.getByText("**/*.env")).toBeInTheDocument()
    // Verdict labels also appear inside the (shimmed) select options, so
    // assert presence rather than uniqueness.
    expect(screen.getAllByText("verdictAllow").length).toBeGreaterThan(0)
    expect(screen.getAllByText("verdictDeny").length).toBeGreaterThan(0)
  })

  it("adds a rule for the selected tool via save()", () => {
    render(<ToolPermissionRulesCard />)
    fireEvent.change(screen.getByLabelText("patternPlaceholder"), {
      target: { value: "git push*" },
    })
    fireEvent.click(screen.getByRole("button", { name: /addRule$/ }))
    expect(save).toHaveBeenCalledWith({
      agentPermissions: { toolRules: { Bash: { "git push*": "ask" } } },
    })
  })

  it("removes a rule and drops the empty tool key", () => {
    setSettings({ agentPermissions: { toolRules: { Bash: { "rm *": "deny" } } } })
    render(<ToolPermissionRulesCard />)
    fireEvent.click(screen.getByLabelText("removeRule: Bash rm *"))
    expect(save).toHaveBeenCalledWith({ agentPermissions: { toolRules: {} } })
  })

  it("supports a custom tool name through the custom option", () => {
    render(<ToolPermissionRulesCard />)
    const selects = screen.getAllByTestId("select")
    fireEvent.change(selects[0], { target: { value: "__custom__" } })
    fireEvent.change(screen.getByLabelText("customToolPlaceholder"), {
      target: { value: "my_plugin_tool" },
    })
    fireEvent.change(screen.getByLabelText("patternPlaceholder"), { target: { value: "*" } })
    fireEvent.click(screen.getByRole("button", { name: /addRule$/ }))
    expect(save).toHaveBeenCalledWith({
      agentPermissions: { toolRules: { my_plugin_tool: { "*": "ask" } } },
    })
  })

  it("previews the winning verdict for a Bash command with the runtime resolver", () => {
    setSettings({
      agentPermissions: { toolRules: { Bash: { "git push*": "deny" } } },
    })
    render(<ToolPermissionRulesCard />)
    fireEvent.change(screen.getByLabelText("previewPlaceholder"), {
      target: { value: "git push origin" },
    })
    const preview = screen.getByTestId("tool-rules-preview")
    expect(preview).toHaveTextContent("verdictDeny")
    expect(preview).toHaveTextContent("previewExplicit")
  })

  it("preview reports the default flow when nothing matches", () => {
    render(<ToolPermissionRulesCard />)
    const selects = screen.getAllByTestId("select")
    fireEvent.change(selects[0], { target: { value: "edit" } })
    fireEvent.change(screen.getByLabelText("previewPlaceholder"), {
      target: { value: "src/index.ts" },
    })
    expect(screen.getByTestId("tool-rules-preview")).toHaveTextContent("previewDefault")
  })

  it("shows the bash segment hint only for shell tools", () => {
    render(<ToolPermissionRulesCard />)
    expect(screen.getByText("bashSegmentHint")).toBeInTheDocument()
    const selects = screen.getAllByTestId("select")
    fireEvent.change(selects[0], { target: { value: "grep" } })
    expect(screen.queryByText("bashSegmentHint")).not.toBeInTheDocument()
  })
})
