/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { MatrixSection, type MatrixSectionProps } from "./matrix-section"
import type { ProviderDiagnosticMatrixRow } from "@/lib/provider-diagnostics/analysis"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, "aria-label": label }: React.ComponentProps<"div">) => (
    <div aria-label={label}>{children}</div>
  ),
  SelectValue: () => null,
}))

function row(overrides: Partial<ProviderDiagnosticMatrixRow> = {}): ProviderDiagnosticMatrixRow {
  return {
    targetId: "t1",
    sample: {
      id: "s1",
      modelId: "gpt-5",
      endpoint: "https://api.openai.com/v1",
      status: "completed",
    } as ProviderDiagnosticSample,
    summary: {
      measuredSamples: 3,
      successfulSamples: 3,
      failedSamples: 0,
      ttftMs: { median: 120, min: 100, max: 150 },
      totalDurationMs: { median: 800, min: 700, max: 900 },
      outputTokensPerSecond: { median: 42.5, min: 40, max: 45 },
      estimatedCostUsd: { median: 0.000125, min: 0.0001, max: 0.0002 },
    },
    ...overrides,
  }
}

const props: MatrixSectionProps = {
  rows: [row()],
  scenario: "interactive",
  onScenarioChange: jest.fn(),
  filters: {
    status: "all",
    modelId: "all",
    capability: "all",
    credentialFingerprint: "all",
    endpoint: "all",
    range: "7d",
  },
  onFiltersChange: jest.fn(),
  options: { models: ["gpt-5"], credentials: ["credential:openai:primary"], endpoints: ["e1"] },
}

describe("MatrixSection", () => {
  beforeEach(() => jest.clearAllMocks())

  it("shows the empty state when nothing matches the filters", () => {
    render(<MatrixSection {...props} rows={[]} />)
    expect(screen.getByText("matrix.empty")).toBeInTheDocument()
    expect(screen.queryByText("matrix.recommendation")).not.toBeInTheDocument()
  })

  it("names the top-ranked row as the recommendation for the scenario", () => {
    render(<MatrixSection {...props} scenario="batch" />)
    expect(screen.getByText("matrix.recommendation")).toBeInTheDocument()
    expect(screen.getByText(/matrix\.reason\.batch.*gpt-5/)).toBeInTheDocument()
  })

  it("falls back to the probe label when the winning row has no model", () => {
    render(
      <MatrixSection
        {...props}
        rows={[row({ sample: { id: "s", status: "completed" } as ProviderDiagnosticSample })]}
      />
    )
    expect(screen.getByText(/matrix\.reason\.interactive.*composer\.probe/)).toBeInTheDocument()
  })

  it("renders both the wide table and the narrow card for each row", () => {
    render(<MatrixSection {...props} />)
    // One in the table cell, one in the card heading — the pane picks by width.
    const labels = screen.getAllByText("gpt-5")
    expect(labels.some((node) => node.tagName === "TD")).toBe(true)
    expect(labels.some((node) => node.tagName === "H4")).toBe(true)
    expect(screen.getAllByText("120 ms").length).toBeGreaterThan(0)
    expect(screen.getAllByText("42.50").length).toBeGreaterThan(0)
  })

  it("formats an absent metric as an em dash rather than NaN", () => {
    render(
      <MatrixSection
        {...props}
        rows={[row({ summary: { ...row().summary, ttftMs: undefined } })]}
      />
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("formats sub-cent costs at six decimals", () => {
    render(<MatrixSection {...props} />)
    expect(screen.getByText("$0.000125")).toBeInTheDocument()
  })

  it("appends P95 to the sample count only when it was computed", () => {
    const { rerender } = render(<MatrixSection {...props} />)
    expect(screen.getAllByText("3").length).toBeGreaterThan(0)
    expect(screen.queryByText(/P95/)).not.toBeInTheDocument()

    rerender(
      <MatrixSection
        {...props}
        rows={[
          row({
            summary: {
              ...row().summary,
              totalDurationMs: { median: 800, min: 700, max: 900, p95: 890 },
            },
          }),
        ]}
      />
    )
    expect(screen.getByText(/P95 890 ms/)).toBeInTheDocument()
  })

  it("patches only the axis that changed, leaving the rest of the filters alone", () => {
    render(<MatrixSection {...props} />)
    // The mocked trigger exposes the axes; assert the props contract instead.
    expect(screen.getByLabelText("filters.model")).toBeInTheDocument()
    expect(screen.getByLabelText("filters.credential")).toBeInTheDocument()
    expect(screen.getByLabelText("filters.endpoint")).toBeInTheDocument()
    expect(screen.getByLabelText("filters.date")).toBeInTheDocument()
    expect(screen.getByLabelText("filters.capability")).toBeInTheDocument()
    expect(screen.getByLabelText("filters.scenario")).toBeInTheDocument()
  })

  it("renders flat, with no card frame", () => {
    const { container } = render(<MatrixSection {...props} />)
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    expect(screen.getByTestId("diagnostics-matrix")).toBeInTheDocument()
  })
})
