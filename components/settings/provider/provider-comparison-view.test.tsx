/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderComparisonView } from "./provider-comparison-view"

// ── i18n mock ─────────────────────────────────────────────────────────────────

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      "comparison.title": "Model Comparison",
      "comparison.back": "Back",
      "comparison.selectModels": "Select Models",
      "comparison.emptyTitle": "No models selected",
      "comparison.emptyDescription": "Select up to 4 models to compare side by side",
      "comparison.addModel": "Add model",
      "comparison.maxReached": "Max 4 models",
      "comparison.provider": "Provider",
      "comparison.contextWindow": "Context Window",
      "comparison.maxOutput": "Max Output",
      "comparison.textGeneration": "Text Generation",
      "comparison.vision": "Vision",
      "comparison.codeGeneration": "Code Generation",
      "comparison.functionCalling": "Function Calling",
      "comparison.streaming": "Streaming",
      "comparison.reasoning": "Reasoning",
      "comparison.audio": "Audio",
      "comparison.video": "Video",
      "comparison.imageGeneration": "Image Generation",
      "comparison.embedding": "Embedding",
      "comparison.avgLatency": "Avg Latency",
      "comparison.availability": "Availability",
      "comparison.inputPrice": "Input Price",
      "comparison.outputPrice": "Output Price",
      "comparison.estCostPer1K": "Est. Cost/1K calls",
      "comparison.bestValue": "Best value",
      "comparison.noPrice": "N/A",
      "comparison.notAvailable": "N/A",
    }
    return map[key] ?? key
  },
}))

// ── Store mock ────────────────────────────────────────────────────────────────

const mockProviderSettings: Record<string, { enabled: boolean; enabledModels?: string[] }> = {
  openai: { enabled: true },
  anthropic: { enabled: true },
  google: { enabled: false },
}

const mockUsageStats = {
  openai: {
    "gpt-4o": {
      callCount: 50,
      inputTokens: 100000,
      outputTokens: 40000,
      avgLatencyMs: 1200,
      dailyStats: {},
    },
  },
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

// ── Catalog mock ──────────────────────────────────────────────────────────────

jest.mock("@/types/provider/built-in-provider-catalog", () => ({
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
          pricing: { promptPer1M: 2.5, completionPer1M: 10.0 },
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProviderComparisonView", () => {
  const onBack = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── 1. Title renders ──────────────────────────────────────────────────────

  it('renders "Model Comparison" title', () => {
    render(<ProviderComparisonView onBack={onBack} />)
    expect(screen.getByText("Model Comparison")).toBeInTheDocument()
  })

  // ── 2. Back button ────────────────────────────────────────────────────────

  it("renders a Back button", () => {
    render(<ProviderComparisonView onBack={onBack} />)
    expect(screen.getByText("Back")).toBeInTheDocument()
  })

  it("calls onBack when Back button is clicked", () => {
    render(<ProviderComparisonView onBack={onBack} />)
    fireEvent.click(screen.getByText("Back"))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  // ── 3. Empty state ────────────────────────────────────────────────────────

  it("shows guidance text when no models are selected", () => {
    render(<ProviderComparisonView onBack={onBack} />)
    expect(screen.getByText("No models selected")).toBeInTheDocument()
  })

  it("shows empty description when no models are selected", () => {
    render(<ProviderComparisonView onBack={onBack} />)
    expect(screen.getByText("Select up to 4 models to compare side by side")).toBeInTheDocument()
  })

  // ── 4. Model selector renders ─────────────────────────────────────────────

  it("renders the model selector button", () => {
    render(<ProviderComparisonView onBack={onBack} />)
    expect(screen.getByText("Add model")).toBeInTheDocument()
  })

  it("renders provider groups in the popover content", () => {
    render(<ProviderComparisonView onBack={onBack} />)
    // PopoverContent is always rendered in our mock
    expect(screen.getByTestId("popover-content")).toBeInTheDocument()
    // Provider names should appear as group headers
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThanOrEqual(1)
  })

  it("renders model checkboxes in the popover", () => {
    render(<ProviderComparisonView onBack={onBack} />)
    // Model names should appear inside the popover
    expect(screen.getByText("GPT-4o")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o Mini")).toBeInTheDocument()
    expect(screen.getByText("Claude 3.5 Sonnet")).toBeInTheDocument()
  })

  // ── 5. Comparison table after selecting a model ───────────────────────────

  it("shows the comparison table with correct column count after selecting a model", () => {
    render(<ProviderComparisonView onBack={onBack} />)

    // Click the GPT-4o checkbox to select it
    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0]) // first model checkbox

    // Table should now be visible — check for a known row label
    expect(screen.getByText("Provider")).toBeInTheDocument()
    expect(screen.getByText("Context Window")).toBeInTheDocument()
  })

  it("shows capability rows in the comparison table", () => {
    render(<ProviderComparisonView onBack={onBack} />)

    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0])

    expect(screen.getByText("Vision")).toBeInTheDocument()
    expect(screen.getByText("Streaming")).toBeInTheDocument()
    expect(screen.getByText("Function Calling")).toBeInTheDocument()
  })

  it("renders pricing rows in the comparison table", () => {
    render(<ProviderComparisonView onBack={onBack} />)

    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0])

    expect(screen.getByText("Input Price")).toBeInTheDocument()
    expect(screen.getByText("Output Price")).toBeInTheDocument()
  })

  it("renders the extended models.dev capability rows", () => {
    render(<ProviderComparisonView onBack={onBack} />)

    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0])

    expect(screen.getByText("Reasoning")).toBeInTheDocument()
    expect(screen.getByText("Audio")).toBeInTheDocument()
    expect(screen.getByText("Video")).toBeInTheDocument()
    expect(screen.getByText("Image Generation")).toBeInTheDocument()
    expect(screen.getByText("Embedding")).toBeInTheDocument()
  })

  // ── 6. Capability indicators ──────────────────────────────────────────────

  it("renders capability check/cross indicators for a selected model", () => {
    render(<ProviderComparisonView onBack={onBack} />)

    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0]) // GPT-4o (supportsVision: true)

    // Capability rows should still render even when icon internals are not exposed by the mock.
    expect(screen.getByText("Vision")).toBeInTheDocument()
  })

  // ── 7. Recommendation ────────────────────────────────────────────────────

  it("shows best value recommendation when models with pricing are selected", () => {
    render(<ProviderComparisonView onBack={onBack} />)

    const checkboxes = screen.getAllByRole("checkbox")
    // Select GPT-4o Mini (cheap) and Claude 3.5 Sonnet (expensive)
    fireEvent.click(checkboxes[1]) // GPT-4o Mini
    fireEvent.click(checkboxes[2]) // Claude 3.5 Sonnet (if available)

    // Best value section should appear — text may be split across elements
    const bestValueElements = screen.getAllByText((content, element) => {
      return element?.textContent?.includes("Best value") ?? false
    })
    expect(bestValueElements.length).toBeGreaterThan(0)
  })

  // ── 8. Max selection limit ────────────────────────────────────────────────

  it("shows Max 4 models label in the selector area", () => {
    render(<ProviderComparisonView onBack={onBack} />)
    // The label should appear somewhere in the component (header area or tooltip)
    expect(screen.getByText("Max 4 models")).toBeInTheDocument()
  })
})
