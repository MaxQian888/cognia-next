/**
 * @jest-environment jsdom
 */
import React, { useState } from "react"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { ProviderComparisonView, compareRows, comparisonModelKey } from "./provider-comparison-view"

// ── i18n mock ─────────────────────────────────────────────────────────────────

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === "comparison.selectedCount") return `${params?.count} / ${params?.max}`
    if (key === "comparison.removeModel") return `Remove ${params?.name}`
    if (key === "comparison.bestValue") return `Best value: ${params?.model}`
    if (key === "comparison.pricePerMillion") return `${params?.price} / 1M`
    const map: Record<string, string> = {
      "comparison.title": "Model Comparison",
      "comparison.back": "Back",
      "comparison.attribute": "Attribute",
      "comparison.emptyTitle": "No models selected",
      "comparison.emptyDescription": "Tick models on a Models tab or add them here",
      "comparison.addModel": "Add model",
      "comparison.maxReached": "Max 4 models",
      "comparison.onlyDifferences": "Only differences",
      "comparison.clearAll": "Clear all",
      "comparison.noDifferences": "No differences",
      "comparison.bestInRow": "Best in row",
      "comparison.providerDisabled": "disabled",
      "comparison.section.limits": "Limits",
      "comparison.section.capabilities": "Capabilities",
      "comparison.section.pricing": "Pricing",
      "comparison.section.performance": "Performance",
      "comparison.contextWindow": "Context Window",
      "comparison.maxOutput": "Max Output",
      "comparison.textGeneration": "Text Generation",
      "comparison.vision": "Vision",
      "comparison.functionCalling": "Function Calling",
      "comparison.streaming": "Streaming",
      "comparison.reasoning": "Reasoning",
      "comparison.audio": "Audio",
      "comparison.video": "Video",
      "comparison.imageGeneration": "Image Generation",
      "comparison.embedding": "Embedding",
      "comparison.avgLatency": "Avg Latency",
      "comparison.inputPrice": "Input Price",
      "comparison.outputPrice": "Output Price",
      "comparison.cacheReadPrice": "Cache Read Price",
      "comparison.cacheWritePrice": "Cache Write Price",
      "comparison.batchInputPrice": "Batch Input Price",
      "comparison.batchOutputPrice": "Batch Output Price",
      "comparison.audioInputPrice": "Audio Input Price",
      "comparison.audioOutputPrice": "Audio Output Price",
      "comparison.estCostPer1K": "Est. Cost/1K calls",
      "comparison.free": "Free",
      "comparison.noPrice": "N/A",
      "comparison.notAvailable": "N/A",
      "comparison.supported": "Supported",
      "comparison.unsupported": "Unsupported",
    }
    return map[key] ?? key
  },
}))

// ── Store mock ────────────────────────────────────────────────────────────────

const mockProviderSettings: Record<string, { enabled: boolean }> = {
  openai: { enabled: true },
  anthropic: { enabled: true },
  google: { enabled: false },
}

const mockUsageStats = {
  "openai:gpt-4o": [{ avgLatencyMs: 1200 }],
}

jest.mock("@/stores", () => ({
  useSettingsStore: (
    selector: (state: {
      providerSettings: typeof mockProviderSettings
      providerUsageStats: typeof mockUsageStats
    }) => unknown
  ) =>
    selector({
      providerSettings: mockProviderSettings,
      providerUsageStats: mockUsageStats,
    }),
}))

jest.mock("@/hooks/settings/use-models-dev-catalog", () => ({
  useModelsDevCatalog: () => ({ row: undefined, isLoading: false, sync: jest.fn() }),
}))

jest.mock("@/components/providers/ai/provider-icon", () => ({
  ProviderIcon: ({ providerId }: { providerId: string }) => (
    <span data-testid={`provider-icon-${providerId}`} />
  ),
}))

// ── Catalog mock ──────────────────────────────────────────────────────────────

jest.mock("@cognia/provider-types/built-in-provider-catalog", () => ({
  getBuiltInProviderCatalogEntry: (id: string) => ({ id, name: id }),
  getBuiltInProviderCatalog: () => [
    {
      id: "openai",
      name: "OpenAI",
      defaultEnabled: true,
      models: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          contextLength: 128000,
          maxOutputTokens: 4096,
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: true,
          pricing: {
            promptPer1M: 2.5,
            completionPer1M: 10.0,
            cachedInputPer1M: 0.25,
            cacheCreationPer1M: 3.13,
          },
        },
        {
          id: "gpt-4o-mini",
          name: "GPT-4o Mini",
          contextLength: 128000,
          maxOutputTokens: 16384,
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: true,
          pricing: { promptPer1M: 0.15, completionPer1M: 0.6 },
        },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      defaultEnabled: true,
      models: [
        {
          id: "claude-3-5-sonnet-20241022",
          name: "Claude 3.5 Sonnet",
          contextLength: 200000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: true,
          pricing: { promptPer1M: 3.0, completionPer1M: 15.0 },
        },
      ],
    },
    {
      id: "google",
      name: "Google AI",
      defaultEnabled: true,
      models: [
        {
          id: "gemini-2.0-flash",
          name: "Gemini 2.0 Flash",
          contextLength: 1000000,
          maxOutputTokens: 8192,
          supportsTools: true,
          supportsVision: true,
          supportsStreaming: true,
          pricing: { promptPer1M: 0.1, completionPer1M: 0.4 },
        },
      ],
    },
  ],
}))

// ── UI component mocks ────────────────────────────────────────────────────────

jest.mock("@/components/ui/button")
jest.mock("@/components/ui/popover")
jest.mock("@/components/ui/checkbox")
jest.mock("@/components/ui/scroll-area")
jest.mock("@/components/ui/badge")

// ── Harness ───────────────────────────────────────────────────────────────────

const GPT4O = comparisonModelKey("openai", "gpt-4o")
const MINI = comparisonModelKey("openai", "gpt-4o-mini")
const SONNET = comparisonModelKey("anthropic", "claude-3-5-sonnet-20241022")
const GEMINI = comparisonModelKey("google", "gemini-2.0-flash")

const onBack = jest.fn()
const onChange = jest.fn()

function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [keys, setKeys] = useState<string[]>(initial)
  return (
    <ProviderComparisonView
      onBack={onBack}
      selectedModelKeys={keys}
      onSelectedModelKeysChange={(next) => {
        onChange(next)
        setKeys(next)
      }}
    />
  )
}

const row = (id: string) => screen.getByTestId(`comparison-row-${id}`)
const pickerBox = (key: string) =>
  document.getElementById(`compare-model-${key}`) as HTMLInputElement

describe("ProviderComparisonView", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders the title, a Back button and the selection count", () => {
    render(<Harness />)
    expect(screen.getByText("Model Comparison")).toBeInTheDocument()
    expect(screen.getByTestId("comparison-count")).toHaveTextContent("0 / 4")
    fireEvent.click(screen.getByText("Back"))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it("shows guidance when nothing is selected, and no table", () => {
    render(<Harness />)
    expect(screen.getByText("No models selected")).toBeInTheDocument()
    expect(screen.queryByTestId("comparison-table")).not.toBeInTheDocument()
    expect(screen.getByTestId("comparison-only-differences")).toBeDisabled()
  })

  it("lists every catalog provider in the picker, enabled ones first and disabled ones labelled", () => {
    render(<Harness />)
    const headings = screen.getAllByText(/OpenAI|Anthropic|Google AI/)
    expect(headings.map((h) => h.textContent)).toEqual(["OpenAI", "Anthropic", "Google AI"])
    expect(screen.getByText("disabled")).toBeInTheDocument()
    expect(pickerBox(GEMINI)).toBeInTheDocument()
  })

  it("is controlled: picking a model reports the new key list and the table follows", () => {
    render(<Harness />)
    fireEvent.click(pickerBox(GPT4O))
    expect(onChange).toHaveBeenLastCalledWith([GPT4O])
    expect(screen.getByTestId("comparison-column-openai:gpt-4o")).toHaveTextContent("GPT-4o")
    expect(screen.getByTestId("comparison-count")).toHaveTextContent("1 / 4")
    expect(row("context")).toHaveTextContent("128K")
    expect(row("maxOutput")).toHaveTextContent("4K")
  })

  it("restores a supplied selection and ignores unknown keys instead of dropping them", () => {
    render(<Harness initial={[GPT4O, "nope:gone", SONNET]} />)
    expect(screen.getByTestId("comparison-column-openai:gpt-4o")).toBeInTheDocument()
    expect(
      screen.getByTestId("comparison-column-anthropic:claude-3-5-sonnet-20241022")
    ).toBeInTheDocument()
    // The count reports the stored keys, so a key that will resolve after a
    // catalog sync still counts against the cap.
    expect(screen.getByTestId("comparison-count")).toHaveTextContent("3 / 4")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("groups the rows into sections", () => {
    render(<Harness initial={[GPT4O]} />)
    for (const section of ["limits", "capabilities", "pricing", "performance"]) {
      expect(screen.getByTestId(`comparison-section-${section}`)).toBeInTheDocument()
    }
    expect(screen.getByText("Vision")).toBeInTheDocument()
    expect(screen.getByText("Function Calling")).toBeInTheDocument()
    expect(row("inputPrice")).toHaveTextContent("$2.50 / 1M")
    expect(row("outputPrice")).toHaveTextContent("$10.00 / 1M")
  })

  it("renders extended pricing rows only for dimensions a model declares, dashing the others", () => {
    render(<Harness initial={[GPT4O, MINI]} />)
    expect(row("cacheRead")).toBeInTheDocument()
    expect(row("cacheWrite")).toBeInTheDocument()
    expect(screen.queryByTestId("comparison-row-batchInput")).not.toBeInTheDocument()
    const cells = within(row("cacheRead")).getAllByRole("cell")
    expect(cells[0]).toHaveTextContent("$0.25 / 1M")
    expect(cells[1]).toHaveTextContent("—")
  })

  it("renders capability check/cross indicators", () => {
    render(<Harness initial={[GPT4O]} />)
    expect(within(row("vision")).getByTestId("capability-yes")).toBeInTheDocument()
    expect(within(row("audio")).getByTestId("capability-no")).toBeInTheDocument()
  })

  it("marks the best value in a numeric row and never on a tie", () => {
    render(<Harness initial={[GPT4O, SONNET]} />)
    // Higher context wins.
    const contextCells = within(row("context")).getAllByRole("cell")
    expect(contextCells[1]).toHaveAttribute("data-best", "true")
    expect(contextCells[0]).not.toHaveAttribute("data-best")
    // Lower input price wins.
    const priceCells = within(row("inputPrice")).getAllByRole("cell")
    expect(priceCells[0]).toHaveAttribute("data-best", "true")
    // Both stream: a tie has no winner, and the row does not differ.
    const streamCells = within(row("streaming")).getAllByRole("cell")
    expect(streamCells.some((c) => c.hasAttribute("data-best"))).toBe(false)
    expect(row("streaming")).not.toHaveAttribute("data-differs")
    expect(row("context")).toHaveAttribute("data-differs", "true")
  })

  it("can hide the rows the models agree on", () => {
    render(<Harness initial={[GPT4O, SONNET]} />)
    expect(row("streaming")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("comparison-only-differences"))
    expect(screen.queryByTestId("comparison-row-streaming")).not.toBeInTheDocument()
    expect(row("context")).toBeInTheDocument()
  })

  it("says so when only-differences leaves nothing", () => {
    // Two models that agree on everything: the fixture has none, so the
    // pure row derivation is exercised directly.
    const ctx = { latencyFor: () => undefined, formatPrice: String, notAvailable: "n/a" }
    const rows = compareRows(
      [
        {
          id: "x",
          section: "limits",
          labelKey: "x",
          kind: "number",
          best: "high",
          value: () => 1,
          format: String,
        },
      ],
      [{} as never, {} as never],
      ctx
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].differs).toBe(false)
    expect(rows[0].bestIndex).toBeNull()
  })

  it("removes a model from its column header and clears the whole selection", () => {
    render(<Harness initial={[GPT4O, SONNET]} />)
    fireEvent.click(screen.getByTestId("comparison-remove-openai:gpt-4o"))
    expect(onChange).toHaveBeenLastCalledWith([SONNET])
    fireEvent.click(screen.getByTestId("comparison-clear"))
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(screen.getByText("No models selected")).toBeInTheDocument()
  })

  it("caps the selection at four and disables the picker past it", () => {
    render(<Harness initial={[GPT4O, MINI, SONNET, GEMINI]} />)
    expect(screen.getByTestId("comparison-add-model")).toBeDisabled()
    expect(screen.getByTestId("comparison-count")).toHaveTextContent("4 / 4")
  })

  it("reads latency from the usage stats keyed by provider:model", () => {
    render(<Harness initial={[GPT4O, SONNET]} />)
    const cells = within(row("latency")).getAllByRole("cell")
    expect(cells[0]).toHaveTextContent("1.2s")
    expect(cells[1]).toHaveTextContent("—")
  })

  it("recommends the cheapest model by average price", () => {
    render(<Harness initial={[GPT4O, MINI]} />)
    expect(screen.getByTestId("comparison-best-value")).toHaveTextContent("Best value: GPT-4o Mini")
  })
})
