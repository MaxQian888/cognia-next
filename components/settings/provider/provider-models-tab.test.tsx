/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { ProviderModelsTab, nextSort, sortModels } from "./provider-models-tab"
import type { ModelConfig } from "./provider-models-tab"

// ── i18n mock ─────────────────────────────────────────────────────────────────

jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, unknown>) => {
    const full = ns === "providers.modelsTab.capability" ? `modelsTab.capability.${key}` : key
    if (full === "modelsTab.countSummary")
      return `Showing ${params?.shown} of ${params?.total} · ${params?.enabled} enabled`
    if (full === "modelsTab.compareSelected") return `${params?.count} of ${params?.max} selected`
    if (full === "modelsTab.compareCheckbox") return `Compare ${params?.name}`
    if (full === "modelsTab.compareLimit") return `Up to ${params?.max}`
    if (full === "modelsTab.sortColumn") return `Sort by ${params?.label}`
    const map: Record<string, string> = {
      "modelsTab.openWeights": "open weights",
      "modelsTab.searchPlaceholder": "Search models...",
      "modelsTab.refreshModels": "Refresh Model List",
      "modelsTab.selectAll": "Select All",
      "modelsTab.deselectAll": "Deselect All",
      "modelsTab.contextWindow": "Context",
      "modelsTab.columnModel": "Model",
      "modelsTab.columnMaxOutput": "Max out",
      "modelsTab.columnPrice": "Price / 1M",
      "modelsTab.columnReleased": "Released",
      "modelsTab.noModels": "No models found",
      "modelsTab.knowledgeCutoff": "Cutoff",
      "modelsTab.capabilities": "Capabilities",
      "modelsTab.enabledOnly": "Enabled only",
      "modelsTab.clearFilters": "Clear filters",
      "modelsTab.compareOpen": "Compare",
      "modelsTab.compareClear": "Clear",
      "modelsTab.capability.vision": "Vision",
      "modelsTab.capability.tools": "Tools",
      "modelsTab.capability.reasoning": "Reasoning",
      "modelsTab.lifecycle.deprecated": "Deprecated",
      "modelsTab.lifecycle.beta": "Beta",
      testConnection: "Test connection",
    }
    return map[full] ?? full
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

jest.mock("@/components/ui/checkbox")

// ── Test data ─────────────────────────────────────────────────────────────────

const mockModels: ModelConfig[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    capabilities: ["tools", "vision"],
    contextLength: 128000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsVision: true,
    pricing: { promptPer1M: 2.5, completionPer1M: 10 },
    releaseDate: "2024-05-13",
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    capabilities: ["tools"],
    contextLength: 128000,
    supportsTools: true,
    supportsVision: false,
    pricing: { promptPer1M: 0.15, completionPer1M: 0.6 },
    releaseDate: "2024-07-18",
  },
  {
    id: "o1",
    name: "O1",
    capabilities: ["tools", "reasoning"],
    contextLength: 200000,
    supportsTools: true,
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

const switchFor = (id: string) =>
  screen.getAllByTestId("switch").find((s) => s.getAttribute("aria-label") === id)!

describe("ProviderModelsTab", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── Table shape ───────────────────────────────────────────────────────────

  it("renders one table row per model", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.getByTestId("models-table")).toBeInTheDocument()
    expect(screen.getByTestId("model-row-gpt-4o")).toBeInTheDocument()
    expect(screen.getByTestId("model-row-gpt-4o-mini")).toBeInTheDocument()
    expect(screen.getByTestId("model-row-o1")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
  })

  it("renders capability glyphs per row in a fixed order with accessible names", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    const row = screen.getByTestId("model-row-gpt-4o")
    const glyphs = within(row).getAllByRole("listitem")
    expect(glyphs.map((g) => g.getAttribute("data-capability"))).toEqual(["tools", "vision"])
    expect(glyphs[0]).toHaveAttribute("aria-label", "Tools")
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

  it("formats context, max output and price as compact numerals", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    const row = screen.getByTestId("model-row-gpt-4o")
    expect(within(row).getByText("128K")).toBeInTheDocument()
    expect(within(row).getByText("16K")).toBeInTheDocument()
    expect(screen.getByTestId("model-price-gpt-4o")).toHaveTextContent("$2.50 / $10.00")
    expect(screen.getByTestId("model-price-o1")).toHaveTextContent("—")
  })

  it("formats large context window size correctly (1M+)", () => {
    render(
      <ProviderModelsTab
        {...defaultProps}
        models={[{ id: "big", name: "Big", contextLength: 1_500_000 }]}
      />
    )
    expect(screen.getByText("1.5M")).toBeInTheDocument()
  })

  it("keeps the sticky header out of the scroller's flow", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    const thead = screen.getByTestId("models-table").querySelector("thead")
    expect(thead).toHaveClass("sticky", "top-0")
  })

  it("keeps the toolbar out of the scroller so only the table moves", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    const tab = screen.getByTestId("models-tab")
    const toolbar = tab.firstElementChild as HTMLElement
    expect(toolbar).toHaveClass("shrink-0")
    expect(toolbar).toContainElement(screen.getByTestId("search-input"))
    expect(toolbar).not.toContainElement(screen.getByTestId("models-table"))
  })

  // ── Sorting ───────────────────────────────────────────────────────────────

  it("cycles a column header through ascending, descending and default", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    const rowsIn = () =>
      screen
        .getAllByTestId(/^model-row-/)
        .map((r) => r.getAttribute("data-testid")!.replace("model-row-", ""))
    expect(rowsIn()).toEqual(["gpt-4o", "gpt-4o-mini", "o1"])
    const header = screen.getByTestId("models-sort-context")
    fireEvent.click(header)
    expect(rowsIn()).toEqual(["gpt-4o", "gpt-4o-mini", "o1"])
    expect(header.closest("th")).toHaveAttribute("aria-sort", "ascending")
    fireEvent.click(header)
    expect(rowsIn()[0]).toBe("o1")
    expect(header.closest("th")).toHaveAttribute("aria-sort", "descending")
    fireEvent.click(header)
    expect(header.closest("th")).toHaveAttribute("aria-sort", "none")
    expect(rowsIn()).toEqual(["gpt-4o", "gpt-4o-mini", "o1"])
  })

  it("sinks models without a value to the bottom in either direction", () => {
    const desc = sortModels(mockModels, { key: "price", direction: "desc" })
    expect(desc.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini", "o1"])
    const asc = sortModels(mockModels, { key: "price", direction: "asc" })
    expect(asc.map((m) => m.id)).toEqual(["gpt-4o-mini", "gpt-4o", "o1"])
  })

  it("nextSort: a different column starts ascending", () => {
    expect(nextSort({ key: "name", direction: "desc" }, "context")).toEqual({
      key: "context",
      direction: "asc",
    })
    expect(nextSort({ key: "name", direction: "desc" }, "name")).toBeNull()
  })

  // ── Search ────────────────────────────────────────────────────────────────

  it("filters models by search query (case-insensitive) and can clear it", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "MINI" } })
    expect(screen.getByText("GPT-4o Mini")).toBeInTheDocument()
    expect(screen.queryByText("O1")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Clear filters"))
    expect(screen.getByText("O1")).toBeInTheDocument()
  })

  it("shows the empty message when search matches nothing", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "zzz" } })
    expect(screen.getByText("No models found")).toBeInTheDocument()
    expect(screen.queryByTestId("models-table")).not.toBeInTheDocument()
  })

  // ── Enable switches ───────────────────────────────────────────────────────

  it("reflects the enabled list on the switches", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(switchFor("gpt-4o")).toBeChecked()
    expect(switchFor("gpt-4o-mini")).not.toBeChecked()
  })

  it("enabling a model adds it to enabled list", () => {
    const onEnabledModelsChange = jest.fn()
    render(<ProviderModelsTab {...defaultProps} onEnabledModelsChange={onEnabledModelsChange} />)
    fireEvent.click(switchFor("gpt-4o-mini"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith(
      expect.arrayContaining(["gpt-4o", "gpt-4o-mini"])
    )
  })

  it("disabling a model removes it from enabled list", () => {
    const onEnabledModelsChange = jest.fn()
    render(
      <ProviderModelsTab
        {...defaultProps}
        enabledModels={["gpt-4o", "gpt-4o-mini"]}
        onEnabledModelsChange={onEnabledModelsChange}
      />
    )
    fireEvent.click(switchFor("gpt-4o"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith(["gpt-4o-mini"])
  })

  // An empty whitelist means "all enabled", so emptying it by switching the
  // last model off would turn every OTHER model back on.
  it("refuses to empty the whitelist when the last enabled model is switched off", () => {
    const onEnabledModelsChange = jest.fn()
    render(<ProviderModelsTab {...defaultProps} onEnabledModelsChange={onEnabledModelsChange} />)
    fireEvent.click(switchFor("gpt-4o"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith(["gpt-4o"])
  })

  it("treats an empty whitelist as all enabled and materializes the first disable", () => {
    const onEnabledModelsChange = jest.fn()
    render(
      <ProviderModelsTab
        {...defaultProps}
        enabledModels={[]}
        onEnabledModelsChange={onEnabledModelsChange}
      />
    )
    expect(switchFor("o1")).toBeChecked()
    fireEvent.click(switchFor("o1"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith(["gpt-4o", "gpt-4o-mini"])
  })

  // ── Empty list ────────────────────────────────────────────────────────────

  it("renders the empty state and no batch toolbar for an empty model list", () => {
    render(<ProviderModelsTab {...defaultProps} models={[]} />)
    expect(screen.getByText("No models found")).toBeInTheDocument()
    expect(screen.queryByText("Select All")).not.toBeInTheDocument()
    expect(screen.queryByTestId("models-table")).not.toBeInTheDocument()
  })

  // ── Provider actions ──────────────────────────────────────────────────────

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
    fireEvent.click(screen.getByText("Refresh Model List"))
    expect(onRefreshModels).toHaveBeenCalledTimes(1)
  })

  it("hides the connection test when no handler is supplied", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.queryByTestId("models-tab-test-connection")).not.toBeInTheDocument()
  })

  it("disables refresh button while refreshing", () => {
    render(<ProviderModelsTab {...defaultProps} isRefreshing />)
    expect(screen.getByText("Refresh Model List").closest("button")).toBeDisabled()
  })

  // ── Batch actions ─────────────────────────────────────────────────────────

  it("Select All preserves the canonical empty list when all models are enabled", () => {
    const onEnabledModelsChange = jest.fn()
    render(
      <ProviderModelsTab
        {...defaultProps}
        enabledModels={[]}
        onEnabledModelsChange={onEnabledModelsChange}
      />
    )
    fireEvent.click(screen.getByText("Select All"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith([])
  })

  it("Deselect All keeps one explicit model because empty means all enabled", () => {
    const onEnabledModelsChange = jest.fn()
    render(
      <ProviderModelsTab
        {...defaultProps}
        enabledModels={[]}
        onEnabledModelsChange={onEnabledModelsChange}
      />
    )
    fireEvent.click(screen.getByText("Deselect All"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith(["gpt-4o"])
  })

  it("Select All with search only enables filtered models", () => {
    const onEnabledModelsChange = jest.fn()
    render(<ProviderModelsTab {...defaultProps} onEnabledModelsChange={onEnabledModelsChange} />)
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "mini" } })
    fireEvent.click(screen.getByText("Select All"))
    expect(onEnabledModelsChange).toHaveBeenCalledWith(["gpt-4o", "gpt-4o-mini"])
  })

  // ── Badges & metadata ─────────────────────────────────────────────────────

  it("renders a lifecycle badge for non-stable models only", () => {
    render(
      <ProviderModelsTab
        {...defaultProps}
        models={[
          { id: "old", name: "Old", status: "deprecated" },
          { id: "beta", name: "Bee", status: "beta" },
          { id: "ok", name: "Ok", status: "stable" },
        ]}
      />
    )
    expect(screen.getByText("Deprecated")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(within(screen.getByTestId("model-row-ok")).queryByTestId("badge")).toBeNull()
  })

  it("renders open weights, variants and the knowledge cutoff", () => {
    render(
      <ProviderModelsTab
        {...defaultProps}
        models={[
          {
            id: "x",
            name: "X",
            openWeights: true,
            variants: ["low", "high"],
            knowledge: "2025-01",
            releaseDate: "2025-02-01",
          },
        ]}
      />
    )
    expect(screen.getByText("open weights")).toBeInTheDocument()
    expect(screen.getByTestId("model-variants-x")).toHaveTextContent("low / high")
    expect(screen.getByText("Cutoff 2025-01")).toBeInTheDocument()
    expect(screen.getByText("2025-02-01")).toBeInTheDocument()
  })

  it("reserves glyph space while models.dev metadata is loading", () => {
    render(
      <ProviderModelsTab {...defaultProps} models={[{ id: "x", name: "X" }]} metadataLoading />
    )
    expect(screen.getByTestId("model-caps-placeholder")).toBeInTheDocument()
  })

  // ── Capability filter ─────────────────────────────────────────────────────

  it("renders a labelled filter chip per distinct capability, AND-combined", () => {
    render(<ProviderModelsTab {...defaultProps} />)
    expect(screen.getByTestId("models-cap-filter-tools")).toHaveTextContent("Tools")
    fireEvent.click(screen.getByTestId("models-cap-filter-vision"))
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.queryByText("O1")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("models-cap-filter-reasoning"))
    expect(screen.getByText("No models found")).toBeInTheDocument()
  })

  // ── Compare column ────────────────────────────────────────────────────────

  describe("compare column", () => {
    const compare = () => ({
      keys: ["openai:gpt-4o", "anthropic:claude"],
      onToggle: jest.fn(),
      onOpen: jest.fn(),
      onClear: jest.fn(),
    })

    it("is absent when no selection is supplied", () => {
      render(<ProviderModelsTab {...defaultProps} />)
      expect(screen.queryByTestId("model-compare-gpt-4o")).not.toBeInTheDocument()
      expect(screen.queryByTestId("models-compare-bar")).not.toBeInTheDocument()
    })

    it("ticks this provider's rows from the cross-provider key set", () => {
      render(<ProviderModelsTab {...defaultProps} compare={compare()} />)
      expect(screen.getByTestId("model-compare-gpt-4o")).toBeChecked()
      expect(screen.getByTestId("model-compare-o1")).not.toBeChecked()
      expect(screen.getByTestId("model-compare-o1")).toHaveAttribute("aria-label", "Compare O1")
    })

    it("toggles with the provider-qualified key", () => {
      const c = compare()
      render(<ProviderModelsTab {...defaultProps} compare={c} />)
      fireEvent.click(screen.getByTestId("model-compare-o1"))
      expect(c.onToggle).toHaveBeenCalledWith("openai:o1")
    })

    it("shows the pinned bar with the global count and opens the comparison", () => {
      const c = compare()
      render(<ProviderModelsTab {...defaultProps} compare={c} />)
      const bar = screen.getByTestId("models-compare-bar")
      expect(bar).toHaveTextContent("2 of 4 selected")
      fireEvent.click(screen.getByTestId("models-compare-open"))
      expect(c.onOpen).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByTestId("models-compare-clear"))
      expect(c.onClear).toHaveBeenCalledTimes(1)
    })

    it("needs two models before Compare is enabled, and hides the bar at zero", () => {
      const { rerender } = render(
        <ProviderModelsTab {...defaultProps} compare={{ ...compare(), keys: ["openai:gpt-4o"] }} />
      )
      expect(screen.getByTestId("models-compare-open")).toBeDisabled()
      rerender(<ProviderModelsTab {...defaultProps} compare={{ ...compare(), keys: [] }} />)
      expect(screen.queryByTestId("models-compare-bar")).not.toBeInTheDocument()
    })

    it("disables the unticked boxes once four models are selected", () => {
      render(
        <ProviderModelsTab
          {...defaultProps}
          compare={{ ...compare(), keys: ["a:1", "b:2", "c:3", "openai:gpt-4o"] }}
        />
      )
      expect(screen.getByTestId("model-compare-gpt-4o")).not.toBeDisabled()
      expect(screen.getByTestId("model-compare-o1")).toBeDisabled()
      expect(screen.getByTestId("model-compare-o1")).toHaveAttribute("title", "Up to 4")
    })
  })
})
