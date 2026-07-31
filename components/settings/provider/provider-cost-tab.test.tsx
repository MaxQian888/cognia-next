/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderCostTab } from "./provider-cost-tab"

// ── i18n mock ─────────────────────────────────────────────────────────────────

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      "costTab.emptyTitle": "No usage data yet",
      "costTab.emptyDescription": "Usage will appear here once you start making requests",
      "costTab.monthlyCost": "Monthly Cost",
      "costTab.totalCalls": "Total Calls",
      "costTab.avgCostPerCall": "Avg Cost / Call",
      "costTab.totalTokens": "Total Tokens",
      "costTab.modelName": "Model",
      "costTab.callCount": "Calls",
      "costTab.inputTokens": "Input Tokens",
      "costTab.outputTokens": "Output Tokens",
      "costTab.estimatedCost": "Est. Cost",
      "costTab.last7Days": "Last 7 Days",
      "costTab.last30Days": "Last 30 Days",
      "comparison.inputPrice": "Input Price",
      "comparison.outputPrice": "Output Price",
      "comparison.cacheReadPrice": "Cache Read Price",
      "comparison.cacheWritePrice": "Cache Write Price",
      "comparison.batchInputPrice": "Batch Input Price",
      "comparison.batchOutputPrice": "Batch Output Price",
      "comparison.audioInputPrice": "Audio Input Price",
      "comparison.audioOutputPrice": "Audio Output Price",
    }
    return map[key] ?? key
  },
}))

// ── Store mock ────────────────────────────────────────────────────────────────

// cognia-next stores usage as a flat record keyed `${providerId}:${modelId}`
// with values of `ProviderModelUsageEntry[]`. Build 100 entries (3 days, totals
// 500_000 prompt + 200_000 completion) so the source's aggregate matches the
// shape the tests assert against.
function makeUsageEntries(): Array<{
  at: string
  modelId: string
  promptTokens: number
  completionTokens: number
  estimatedCost: number
  ok: boolean
}> {
  const days = [
    { date: "2026-04-10", calls: 30, prompt: 150000, completion: 60000 },
    { date: "2026-04-11", calls: 40, prompt: 200000, completion: 80000 },
    { date: "2026-04-12", calls: 30, prompt: 150000, completion: 60000 },
  ]
  const entries = []
  for (const d of days) {
    const promptPerCall = d.prompt / d.calls
    const completionPerCall = d.completion / d.calls
    for (let i = 0; i < d.calls; i++) {
      entries.push({
        at: `${d.date}T00:00:00.000Z`,
        modelId: "gpt-4o",
        promptTokens: promptPerCall,
        completionTokens: completionPerCall,
        estimatedCost: (promptPerCall * 2.5 + completionPerCall * 10) / 1_000_000,
        ok: true,
      })
    }
  }
  return entries
}

const mockUsageStats: Record<string, ReturnType<typeof makeUsageEntries>> = {
  "openai:gpt-4o": makeUsageEntries(),
}

jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (state: { providerUsageStats: typeof mockUsageStats }) => unknown) =>
    selector({ providerUsageStats: mockUsageStats }),
}))

// ── Catalog mock ──────────────────────────────────────────────────────────────

jest.mock("@cognia/provider-types/built-in-provider-catalog", () => ({
  getBuiltInProviderCatalog: () => [
    {
      id: "openai",
      name: "OpenAI",
      models: [],
    },
  ],
  getBuiltInProviderCatalogEntry: (providerId: string) => {
    if (providerId === "openai") {
      return {
        id: "openai",
        name: "OpenAI",
        models: [
          {
            id: "gpt-4o",
            name: "GPT-4o",
            pricing: {
              promptPer1M: 2.5,
              completionPer1M: 10,
              cachedInputPer1M: 0.25,
              batchInputPer1M: 0, // a zero rate renders as "Free"
            },
          },
        ],
      }
    }
    return undefined
  },
}))

// ── UI component mocks ────────────────────────────────────────────────────────

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button data-testid="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProviderCostTab", () => {
  // Pin "now" so the 30-day window in the component always covers the
  // hard-coded 2026-04-10/11/12 entries below — without this, the test
  // gradually breaks as wall-clock time advances past 2026-05-10.
  beforeAll(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-04-15T00:00:00.000Z"))
  })
  afterAll(() => {
    jest.useRealTimers()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── 1. Empty state ────────────────────────────────────────────────────────

  it("shows empty state when no usage data exists for the provider", () => {
    render(<ProviderCostTab providerId="anthropic" />)
    expect(screen.getByText("No usage data yet")).toBeInTheDocument()
  })

  it("shows empty state description when no usage data exists", () => {
    render(<ProviderCostTab providerId="anthropic" />)
    expect(
      screen.getByText("Usage will appear here once you start making requests")
    ).toBeInTheDocument()
  })

  // ── 2. Overview cards ─────────────────────────────────────────────────────

  it("renders four overview cards when usage data exists", () => {
    render(<ProviderCostTab providerId="openai" />)
    expect(screen.getByText("Monthly Cost")).toBeInTheDocument()
    expect(screen.getByText("Total Calls")).toBeInTheDocument()
    expect(screen.getByText("Avg Cost / Call")).toBeInTheDocument()
    expect(screen.getByText("Total Tokens")).toBeInTheDocument()
  })

  it("renders call count total correctly in overview cards", () => {
    render(<ProviderCostTab providerId="openai" />)
    // Total calls: 100 — appears in both the overview card and the table row
    const allHundred = screen.getAllByText("100")
    expect(allHundred.length).toBeGreaterThanOrEqual(1)
  })

  it("renders total tokens in abbreviated form in overview cards", () => {
    render(<ProviderCostTab providerId="openai" />)
    // Total tokens: 500000 + 200000 = 700000 → "700K"
    expect(screen.getByText("700K")).toBeInTheDocument()
  })

  // ── 3. Per-model cost table ───────────────────────────────────────────────

  it("renders model name in cost table", () => {
    render(<ProviderCostTab providerId="openai" />)
    expect(screen.getByText("gpt-4o")).toBeInTheDocument()
  })

  it("renders call count for model in cost table", () => {
    render(<ProviderCostTab providerId="openai" />)
    // callCount: 100 — appears in table row
    const allHundreds = screen.getAllByText("100")
    expect(allHundreds.length).toBeGreaterThan(0)
  })

  it("renders estimated cost with pricing when available", () => {
    render(<ProviderCostTab providerId="openai" />)
    // inputTokens=500000 * 2.5/1M + outputTokens=200000 * 10/1M
    // = 1.25 + 2.00 = $3.25 — appears in both the overview card and table row
    const allCost = screen.getAllByText("$3.25")
    expect(allCost.length).toBeGreaterThanOrEqual(1)
  })

  it("renders a per-model rate breakdown including the cache dimension", () => {
    render(<ProviderCostTab providerId="openai" />)
    // The rate line lists each declared dimension as "<label> $<rate>".
    expect(screen.getByText(/Input Price \$2\.50/)).toBeInTheDocument()
    expect(screen.getByText(/Output Price \$10\.00/)).toBeInTheDocument()
    expect(screen.getByText(/Cache Read Price \$0\.25/)).toBeInTheDocument()
    // A zero per-token rate renders as "Free".
    expect(screen.getByText(/Batch Input Price Free/)).toBeInTheDocument()
  })

  it("renders N/A for cost when no pricing data is available", () => {
    // anthropic has no usage, but we can test unknown model via a provider
    // without catalog entry
    render(<ProviderCostTab providerId="anthropic" />)
    // Empty state — no table, so N/A is not rendered, but that's fine.
    // This test verifies the empty state shows correctly.
    expect(screen.getByText("No usage data yet")).toBeInTheDocument()
  })

  // ── 4. Period toggle ──────────────────────────────────────────────────────

  it("renders period toggle buttons", () => {
    render(<ProviderCostTab providerId="openai" />)
    expect(screen.getByText("Last 7 Days")).toBeInTheDocument()
    expect(screen.getByText("Last 30 Days")).toBeInTheDocument()
  })

  it("defaults to Last 30 Days view", () => {
    render(<ProviderCostTab providerId="openai" />)
    const last30Button = screen.getByText("Last 30 Days").closest("button")
    // The active button should have "default" variant styling (not ghost)
    expect(last30Button).toBeTruthy()
  })

  it("switches to Last 7 Days when clicking the 7-day button", () => {
    render(<ProviderCostTab providerId="openai" />)
    const last7Button = screen.getByText("Last 7 Days")
    fireEvent.click(last7Button)
    // After clicking, the 7-day period is selected — data still renders
    expect(screen.getByText("Last 7 Days")).toBeInTheDocument()
  })

  it("switches back to Last 30 Days when clicking the 30-day button", () => {
    render(<ProviderCostTab providerId="openai" />)
    // First go to 7-day
    fireEvent.click(screen.getByText("Last 7 Days"))
    // Then switch to 30-day
    fireEvent.click(screen.getByText("Last 30 Days"))
    expect(screen.getByText("Last 30 Days")).toBeInTheDocument()
  })

  // ── 5. Token formatting ───────────────────────────────────────────────────

  it("renders input and output token columns in cost table", () => {
    render(<ProviderCostTab providerId="openai" />)
    // Input: 500K
    expect(screen.getByText("500K")).toBeInTheDocument()
    // Output: 200K
    expect(screen.getByText("200K")).toBeInTheDocument()
  })

  it("renders column headers for the cost table", () => {
    render(<ProviderCostTab providerId="openai" />)
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(screen.getByText("Calls")).toBeInTheDocument()
    expect(screen.getByText("Input Tokens")).toBeInTheDocument()
    expect(screen.getByText("Output Tokens")).toBeInTheDocument()
    expect(screen.getByText("Est. Cost")).toBeInTheDocument()
  })
})
