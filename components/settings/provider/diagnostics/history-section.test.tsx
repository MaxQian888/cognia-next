/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { HistorySection, type HistorySectionProps } from "./history-section"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

function sample(overrides: Partial<ProviderDiagnosticSample> = {}): ProviderDiagnosticSample {
  return {
    id: "s1",
    jobId: "j1",
    targetId: "t1",
    providerId: "openai",
    capability: "text-generation",
    credentialFingerprint: "credential:openai:primary",
    endpoint: "https://api.openai.com/v1",
    startedAt: 1_700_000_000_000,
    status: "completed",
    sampleRole: "measured",
    modelId: "gpt-5",
    metrics: { totalDurationMs: 800 },
    ...overrides,
  } as ProviderDiagnosticSample
}

const props: HistorySectionProps = {
  samples: [sample()],
  trend: { samples: [sample()], maxDurationMs: 800 },
  onExport: jest.fn(),
  onClear: jest.fn(),
}

/** The section is collapsed by default; open it to assert on its body. */
function renderOpen(overrides: Partial<HistorySectionProps> = {}) {
  const result = render(<HistorySection {...props} {...overrides} />)
  fireEvent.click(screen.getByRole("button", { name: /history\.title/ }))
  return result
}

describe("HistorySection", () => {
  beforeEach(() => jest.clearAllMocks())

  it("starts collapsed — it is reference material, not the headline", () => {
    render(<HistorySection {...props} />)
    expect(screen.queryByText(/gpt-5/)).not.toBeInTheDocument()
    expect(screen.getByText("history.title")).toBeInTheDocument()
  })

  it("lists the sample with its model, endpoint and duration once opened", () => {
    renderOpen()
    expect(screen.getByText("gpt-5 · https://api.openai.com/v1")).toBeInTheDocument()
    expect(screen.getByText("800 ms")).toBeInTheDocument()
  })

  it("shows the empty state instead of an empty chart", () => {
    renderOpen({ samples: [], trend: { samples: [], maxDurationMs: 1 } })
    expect(screen.getByText("history.empty")).toBeInTheDocument()
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("labels the trend chart for screen readers", () => {
    renderOpen()
    expect(screen.getByRole("img", { name: "history.chartAria" })).toBeInTheDocument()
  })

  it("gives a near-zero sample a visible floor height rather than collapsing it", () => {
    renderOpen({
      trend: {
        samples: [
          sample({
            id: "tiny",
            metrics: { totalDurationMs: 1 },
          } as Partial<ProviderDiagnosticSample>),
        ],
        maxDurationMs: 10_000,
      },
    })
    const bar = screen.getByRole("img").firstElementChild as HTMLElement
    expect(bar.style.height).toBe("4%")
  })

  it("caps the listed rows at twenty — the export carries the rest", () => {
    const many = Array.from({ length: 25 }, (_, i) => sample({ id: `s${i}` }))
    renderOpen({ samples: many })
    expect(screen.getAllByText("gpt-5 · https://api.openai.com/v1")).toHaveLength(20)
  })

  it("exports and clears through the parent", () => {
    render(<HistorySection {...props} />)
    fireEvent.click(screen.getByLabelText("history.exportJson"))
    expect(props.onExport).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText("history.clear"))
    expect(props.onClear).toHaveBeenCalledTimes(1)
  })

  it("lets a paired client export but not clear the desktop's log", () => {
    render(<HistorySection {...props} clearDisabled />)
    expect(screen.getByLabelText("history.clear")).toBeDisabled()
    expect(screen.getByLabelText("history.exportJson")).toBeEnabled()
  })
})
