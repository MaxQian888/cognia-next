/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderModelsTab } from "./provider-models-tab"
import type { ModelConfig } from "./provider-models-tab"

// ── i18n mock ─────────────────────────────────────────────────────────────────

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      "modelsTab.searchPlaceholder": "Search models...",
      "modelsTab.refreshModels": "Refresh Model List",
      "modelsTab.selectAll": "Select All",
      "modelsTab.deselectAll": "Deselect All",
      "modelsTab.batchEnable": "Enable Selected",
      "modelsTab.batchDisable": "Disable Selected",
      "modelsTab.contextWindow": "Context",
      "modelsTab.noModels": "No models found",
    }
    return map[key] ?? key
  },
}))

// ── UI component mocks ────────────────────────────────────────────────────────

jest.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input data-testid="search-input" {...props} />
  ),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button data-testid="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
}))

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
    ...rest
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
    "aria-label"?: string
    [key: string]: unknown
  }) => (
    <input
      type="checkbox"
      data-testid="switch"
      aria-label={ariaLabel}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      {...rest}
    />
  ),
}))

// ── Test data ─────────────────────────────────────────────────────────────────

const mockModels: ModelConfig[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    capabilities: ["Text", "Vision"],
    contextLength: 128000,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    capabilities: ["Text"],
    contextLength: 128000,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "o1",
    name: "O1",
    capabilities: ["Text", "Code"],
    contextLength: 200000,
    supportsTools: false,
    supportsVision: false,
  },
]

const defaultProps = {
  providerId: "openai",
  models: mockModels,
  enabledModels: ["gpt-4o"],
  onEnabledModelsChange: jest.fn(),
  onTestConnection: jest.fn(),
  isTesting: false,
}

describe("ProviderModelsTab", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── 1. Renders model cards for each model in the list ─────────────────────

  it("renders a card for each model in the list", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o Mini")).toBeInTheDocument()
    expect(screen.getByText("O1")).toBeInTheDocument()
  })

  it("renders capability badges for each model", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    const badges = screen.getAllByTestId("badge")
    // GPT-4o has Text + Vision, GPT-4o Mini has Text, O1 has Text + Code
    expect(badges.length).toBeGreaterThanOrEqual(4)
  })

  it("formats context window size correctly (128K)", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    // 128000 → "128K"
    const contextLabels = screen.getAllByText(/128K/)
    expect(contextLabels.length).toBeGreaterThan(0)
  })

  it("formats large context window size correctly (1M+)", () => {
    const propsWithLarge = {
      ...defaultProps,
      models: [
        {
          id: "gemini-1m",
          name: "Gemini 1M",
          contextLength: 1000000,
        },
      ],
    }
    const { container } = render(<ProviderModelsTab {...propsWithLarge} />)
    // The context span contains "1M Context" as text nodes — verify via container text
    expect(container.textContent).toMatch(/1M/)
  })

  // ── 2. Search filters models by name ──────────────────────────────────────

  it("shows all models when search is empty", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o Mini")).toBeInTheDocument()
    expect(screen.getByText("O1")).toBeInTheDocument()
  })

  it("filters models by search query (case-insensitive)", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    const searchInput = screen.getByTestId("search-input")
    fireEvent.change(searchInput, { target: { value: "gpt" } })
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o Mini")).toBeInTheDocument()
    expect(screen.queryByText("O1")).not.toBeInTheDocument()
  })

  it("shows no models message when search matches nothing", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    const searchInput = screen.getByTestId("search-input")
    fireEvent.change(searchInput, { target: { value: "nonexistent-model-xyz" } })
    expect(screen.getByText("No models found")).toBeInTheDocument()
  })

  // ── 3. Enabled models show switch in "on" state ───────────────────────────

  it("shows enabled model switch as checked", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    // gpt-4o is in enabledModels
    const switches = screen.getAllByTestId("switch")
    const enabledSwitch = switches.find((s) => s.getAttribute("aria-label") === "gpt-4o")
    expect(enabledSwitch).toBeChecked()
  })

  it("shows disabled model switch as unchecked", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    // gpt-4o-mini is NOT in enabledModels
    const switches = screen.getAllByTestId("switch")
    const disabledSwitch = switches.find((s) => s.getAttribute("aria-label") === "gpt-4o-mini")
    expect(disabledSwitch).not.toBeChecked()
  })

  // ── 4. Toggling a switch calls onEnabledModelsChange ─────────────────────

  it("enabling a model adds it to enabled list", () => {
    const onEnabledModelsChange = jest.fn()
    render(<ProviderModelsTab {...defaultProps} onEnabledModelsChange={onEnabledModelsChange} />)
    const switches = screen.getAllByTestId("switch")
    const miniSwitch = switches.find((s) => s.getAttribute("aria-label") === "gpt-4o-mini")
    fireEvent.click(miniSwitch!)
    expect(onEnabledModelsChange).toHaveBeenCalledWith(
      expect.arrayContaining(["gpt-4o", "gpt-4o-mini"])
    )
  })

  it("disabling a model removes it from enabled list", () => {
    const onEnabledModelsChange = jest.fn()
    render(<ProviderModelsTab {...defaultProps} onEnabledModelsChange={onEnabledModelsChange} />)
    const switches = screen.getAllByTestId("switch")
    const enabledSwitch = switches.find((s) => s.getAttribute("aria-label") === "gpt-4o")
    fireEvent.click(enabledSwitch!)
    expect(onEnabledModelsChange).toHaveBeenCalledWith(expect.not.arrayContaining(["gpt-4o"]))
  })

  // ── 5. Shows empty state when models array is empty ───────────────────────

  it('shows "No models found" empty state when models array is empty', () => {
    render(<ProviderModelsTab {...defaultProps} models={[]} />)
    expect(screen.getByText("No models found")).toBeInTheDocument()
  })

  it("does not render any model cards when models array is empty", () => {
    render(<ProviderModelsTab {...defaultProps} models={[]} />)
    expect(screen.queryByTestId("switch")).not.toBeInTheDocument()
  })

  // ── 6. Refresh button calls onTestConnection ───────────────────────────────

  it("calls onTestConnection when refresh button is clicked", () => {
    const onTestConnection = jest.fn()
    render(<ProviderModelsTab {...defaultProps} onTestConnection={onTestConnection} />)
    const refreshButton = screen.getByText("Refresh Model List")
    fireEvent.click(refreshButton)
    expect(onTestConnection).toHaveBeenCalledTimes(1)
  })

  it("disables refresh button while refreshing", () => {
    render(<ProviderModelsTab {...defaultProps} isTesting={true} />)
    const refreshButton = screen.getByText("Refresh Model List").closest("button")
    expect(refreshButton).toBeDisabled()
  })

  // ── 7. Batch operations toolbar ───────────────────────────────────────────

  it("shows batch toolbar when models are present", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.getByText("Select All")).toBeInTheDocument()
    expect(screen.getByText("Deselect All")).toBeInTheDocument()
  })

  it("does not show batch toolbar when models array is empty", () => {
    render(<ProviderModelsTab {...defaultProps} models={[]} />)
    expect(screen.queryByText("Select All")).not.toBeInTheDocument()
    expect(screen.queryByText("Deselect All")).not.toBeInTheDocument()
  })

  it("Select All enables all visible (filtered) models", () => {
    const onEnabledModelsChange = jest.fn()
    render(
      <ProviderModelsTab
        {...defaultProps}
        enabledModels={[]}
        onEnabledModelsChange={onEnabledModelsChange}
      />
    )
    fireEvent.click(screen.getByText("Select All"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith(
      expect.arrayContaining(["gpt-4o", "gpt-4o-mini", "o1"])
    )
  })

  it("Deselect All disables all visible (filtered) models", () => {
    const onEnabledModelsChange = jest.fn()
    render(
      <ProviderModelsTab
        {...defaultProps}
        enabledModels={["gpt-4o", "gpt-4o-mini", "o1"]}
        onEnabledModelsChange={onEnabledModelsChange}
      />
    )
    fireEvent.click(screen.getByText("Deselect All"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith([])
  })

  it("Select All with search only enables filtered models", () => {
    const onEnabledModelsChange = jest.fn()
    render(
      <ProviderModelsTab
        {...defaultProps}
        enabledModels={[]}
        onEnabledModelsChange={onEnabledModelsChange}
      />
    )
    // Filter to only GPT models
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "gpt" } })
    fireEvent.click(screen.getByText("Select All"))
    const called = onEnabledModelsChange.mock.calls[0][0] as string[]
    expect(called).toContain("gpt-4o")
    expect(called).toContain("gpt-4o-mini")
    expect(called).not.toContain("o1")
  })

  it("shows Enable Selected and Disable Selected buttons", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.getByText("Enable Selected")).toBeInTheDocument()
    expect(screen.getByText("Disable Selected")).toBeInTheDocument()
  })
})
