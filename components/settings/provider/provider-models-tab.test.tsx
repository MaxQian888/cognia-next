/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderModelsTab } from "./provider-models-tab"
import type { ModelConfig } from "./provider-models-tab"

// ── i18n mock ─────────────────────────────────────────────────────────────────

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === "modelsTab.sortBy") return `Sort: ${params?.label}`
    if (key === "modelsTab.countSummary")
      return `Showing ${params?.shown} of ${params?.total} · ${params?.enabled} enabled`
    if (key === "modelsTab.modes") return `${params?.count} modes`
    const map: Record<string, string> = {
      "modelsTab.maxOutput": "max out",
      "modelsTab.openWeights": "open weights",
      "modelsTab.searchPlaceholder": "Search models...",
      "modelsTab.refreshModels": "Refresh Model List",
      "modelsTab.selectAll": "Select All",
      "modelsTab.deselectAll": "Deselect All",
      "modelsTab.batchEnable": "Enable Selected",
      "modelsTab.batchDisable": "Disable Selected",
      "modelsTab.contextWindow": "Context",
      "modelsTab.noModels": "No models found",
      "modelsTab.knowledgeCutoff": "Cutoff",
      "modelsTab.updated": "Updated",
      "modelsTab.capabilities": "Capabilities",
      "modelsTab.enabledOnly": "Enabled only",
      "modelsTab.clearFilters": "Clear filters",
      "modelsTab.sortDefault": "Default",
      "modelsTab.sortName": "Name",
      "modelsTab.sortContext": "Context",
      "modelsTab.sortRelease": "Newest",
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

jest.mock("@/components/ui/button")

jest.mock("@/components/ui/badge")

jest.mock("@/components/ui/switch")

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
  onRefreshModels: jest.fn(),
  isRefreshing: false,
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

  it("shows the latest diagnostic state on the matching model row", () => {
    render(
      <ProviderModelsTab
        {...defaultProps}
        diagnosticStatusByModel={{ "gpt-4o": "passed", o1: "failed" }}
      />
    )
    expect(screen.getByTestId("model-diagnostic-gpt-4o")).toHaveAttribute(
      "data-diagnostic-status",
      "passed"
    )
    expect(screen.getByTestId("model-diagnostic-o1")).toHaveAttribute(
      "data-diagnostic-status",
      "failed"
    )
  })

  it("formats context window size correctly (128K)", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    // 128000 → "128K"
    const contextLabels = screen.getAllByText(/128K/)
    expect(contextLabels.length).toBeGreaterThan(0)
  })

  it("renders max output, open-weights badge, and reasoning mode count", () => {
    render(
      <ProviderModelsTab
        {...defaultProps}
        models={[
          {
            id: "glm-x",
            name: "GLM X",
            capabilities: ["Text"],
            contextLength: 128000,
            maxOutputTokens: 64000,
            openWeights: true,
            modeCount: 2,
          },
        ]}
        enabledModels={[]}
      />
    )
    expect(screen.getByText(/64K max out/)).toBeInTheDocument()
    expect(screen.getByText("open weights")).toBeInTheDocument()
    expect(screen.getByText("2 modes")).toBeInTheDocument()
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

  // ── 6. Refresh button calls onRefreshModels ───────────────────────────────

  it("offers a connection test that is distinct from the model refresh", () => {
    const onRefreshModels = jest.fn()
    const onTestConnection = jest.fn()
    render(
      <ProviderModelsTab
        {...defaultProps}
        onRefreshModels={onRefreshModels}
        onTestConnection={onTestConnection}
      />
    )
    fireEvent.click(screen.getByTestId("models-tab-test-connection"))
    expect(onTestConnection).toHaveBeenCalledTimes(1)
    expect(onRefreshModels).not.toHaveBeenCalled()
  })

  it("hides the connection test when no handler is supplied", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.queryByTestId("models-tab-test-connection")).not.toBeInTheDocument()
  })

  it("calls onRefreshModels when refresh button is clicked", () => {
    const onRefreshModels = jest.fn()
    render(<ProviderModelsTab {...defaultProps} onRefreshModels={onRefreshModels} />)
    const refreshButton = screen.getByText("Refresh Model List")
    fireEvent.click(refreshButton)
    expect(onRefreshModels).toHaveBeenCalledTimes(1)
  })

  it("disables refresh button while refreshing", () => {
    render(<ProviderModelsTab {...defaultProps} isRefreshing={true} />)
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

  // "Enable Selected" / "Disable Selected" were removed: they ran the exact
  // same handlers as Select All / Deselect All — one action under two names.
  it("no longer duplicates the batch actions under a second pair of names", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.queryByText("Enable Selected")).not.toBeInTheDocument()
    expect(screen.queryByText("Disable Selected")).not.toBeInTheDocument()
  })

  // ── 7b. Toolbar stays pinned; only the list scrolls ───────────────────────

  it("keeps the toolbar out of the scroller so only the model list moves", () => {
    const { container } = render(<ProviderModelsTab {...defaultProps} />)
    const scroller = container.querySelector('[data-slot="scroll-area"]')
    expect(scroller).toBeInTheDocument()
    // Search + batch actions live above the scroller, not inside it.
    expect(scroller).not.toContainElement(screen.getByTestId("search-input"))
    expect(scroller).not.toContainElement(screen.getByText("Select All").closest("button"))
    // The model cards do live inside it.
    expect(scroller).toContainElement(screen.getByText("GPT-4o"))
  })

  // ── 8. models.dev metadata: status badge, knowledge cutoff, updated ────────

  const metaModel: ModelConfig = {
    id: "claude-legacy",
    name: "Claude Legacy",
    contextLength: 200000,
    status: "deprecated",
    knowledge: "2024-04",
    lastUpdated: "2025-02-01",
    family: "claude-3",
  }

  it("renders a status badge for non-stable models", () => {
    render(<ProviderModelsTab {...defaultProps} models={[metaModel]} />)
    expect(screen.getByText("deprecated")).toBeInTheDocument()
  })

  it("renders an outline status badge for preview states like beta", () => {
    render(
      <ProviderModelsTab
        {...defaultProps}
        models={[{ ...metaModel, status: "beta" }]}
        enabledModels={[]}
      />
    )
    expect(screen.getByText("beta")).toBeInTheDocument()
  })

  it("formats sub-1K context windows verbatim", () => {
    const { container } = render(
      <ProviderModelsTab
        {...defaultProps}
        models={[{ id: "tiny", name: "Tiny", contextLength: 512 }]}
        enabledModels={[]}
      />
    )
    expect(container.textContent).toContain("512")
  })

  it("does not render a status badge for stable/empty status", () => {
    render(
      <ProviderModelsTab
        {...defaultProps}
        models={[{ ...metaModel, status: "stable" }]}
        enabledModels={[]}
      />
    )
    expect(screen.queryByText("stable")).not.toBeInTheDocument()
  })

  it("renders knowledge cutoff and last-updated metadata", () => {
    const { container } = render(
      <ProviderModelsTab {...defaultProps} models={[metaModel]} enabledModels={[]} />
    )
    expect(container.textContent).toContain("Cutoff 2024-04")
    expect(container.textContent).toContain("Updated 2025-02-01")
  })

  it("omits metadata spans when the fields are absent", () => {
    const { container } = render(
      <ProviderModelsTab
        {...defaultProps}
        models={[{ id: "x", name: "Bare", contextLength: 1000 }]}
        enabledModels={[]}
      />
    )
    expect(container.textContent).not.toContain("Cutoff")
    expect(container.textContent).not.toContain("Updated")
  })

  // ── 9. Filtering: capability chips, enabled-only, sort, clear, count ───────

  it("renders a capability filter chip per distinct capability", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    // Union across the mock models is Code / Text / Vision.
    expect(screen.getByRole("button", { name: "Code" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Text" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Vision" })).toBeInTheDocument()
  })

  it("does not render capability chips when no models are present", () => {
    render(<ProviderModelsTab {...defaultProps} models={[]} />)
    expect(screen.queryByRole("button", { name: "Text" })).not.toBeInTheDocument()
  })

  it("filtering by a capability narrows the grid (AND semantics)", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    fireEvent.click(screen.getByRole("button", { name: "Vision" }))
    // Only GPT-4o exposes Vision.
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.queryByText("GPT-4o Mini")).not.toBeInTheDocument()
    expect(screen.queryByText("O1")).not.toBeInTheDocument()
  })

  it("enabled-only toggle shows only enabled models", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    fireEvent.click(screen.getByRole("button", { name: "Enabled only" }))
    // Only gpt-4o is in enabledModels.
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.queryByText("GPT-4o Mini")).not.toBeInTheDocument()
    expect(screen.queryByText("O1")).not.toBeInTheDocument()
  })

  it("cycles the sort mode label on click", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.getByRole("button", { name: "Sort: Default" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Sort: Default" }))
    expect(screen.getByRole("button", { name: "Sort: Name" })).toBeInTheDocument()
  })

  it("shows a clear-filters button only when a filter is active, and it resets", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Vision" }))
    const clear = screen.getByRole("button", { name: "Clear filters" })
    fireEvent.click(clear)
    // All models visible again after reset.
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o Mini")).toBeInTheDocument()
    expect(screen.getByText("O1")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument()
  })

  it("renders a count summary that reflects shown / total / enabled", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.getByText("Showing 3 of 3 · 1 enabled")).toBeInTheDocument()
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "gpt" } })
    expect(screen.getByText("Showing 2 of 3 · 1 enabled")).toBeInTheDocument()
  })
})

// The models.dev catalog is a separate Dexie read that lands after the static
// provider catalog, so cards used to paint bare and then *grow* a capability
// row, shifting everything below.
describe("ProviderModelsTab late metadata", () => {
  const bare = [
    { id: "m1", name: "M1", contextLength: 1000 },
    { id: "m2", name: "M2", contextLength: 2000 },
  ]

  it("reserves the capability row while the catalog read is in flight", () => {
    render(<ProviderModelsTab {...defaultProps} models={bare} metadataLoading />)
    expect(screen.getAllByTestId("model-caps-placeholder")).toHaveLength(2)
  })

  it("drops the placeholder once metadata has landed", () => {
    render(<ProviderModelsTab {...defaultProps} models={bare} metadataLoading={false} />)
    expect(screen.queryByTestId("model-caps-placeholder")).not.toBeInTheDocument()
  })

  it("never placeholders a model that already has capabilities", () => {
    render(<ProviderModelsTab {...defaultProps} metadataLoading />)
    expect(screen.queryByTestId("model-caps-placeholder")).not.toBeInTheDocument()
    expect(screen.getAllByText("Vision").length).toBeGreaterThan(0)
  })

  it("defaults to no placeholder when the prop is omitted", () => {
    render(<ProviderModelsTab {...defaultProps} models={bare} />)
    expect(screen.queryByTestId("model-caps-placeholder")).not.toBeInTheDocument()
  })
})
