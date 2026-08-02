/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { SummarySection } from "./summary-section"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

function sample(overrides: Partial<ProviderDiagnosticSample>): ProviderDiagnosticSample {
  return {
    id: "s1",
    jobId: "j1",
    targetId: "t1",
    providerId: "openai",
    capability: "probe",
    credentialFingerprint: "credential:openai:primary",
    endpoint: "https://api.openai.com/v1",
    startedAt: 1,
    status: "completed",
    sampleRole: "measured",
    ...overrides,
  } as ProviderDiagnosticSample
}

describe("SummarySection", () => {
  it("interpolates the provider name into the description", () => {
    render(<SummarySection providerName="OpenAI" />)
    expect(screen.getByText(/summary\.description.*OpenAI/)).toBeInTheDocument()
  })

  it("reports unknown / unverified across all three tiles with no sample yet", () => {
    render(<SummarySection providerName="OpenAI" />)
    expect(screen.getByText("status.unknown")).toBeInTheDocument()
    expect(screen.getAllByText("status.unverified")).toHaveLength(2)
  })

  it("shows reachable transport once a probe got through", () => {
    render(
      <SummarySection
        providerName="OpenAI"
        latestSample={sample({ probe: { reachable: true } } as Partial<ProviderDiagnosticSample>)}
      />
    )
    expect(screen.getByText("status.reachable")).toBeInTheDocument()
  })

  it("distinguishes rejected credentials from never-tested ones", () => {
    const { rerender } = render(
      <SummarySection
        providerName="OpenAI"
        latestSample={sample({
          probe: { authenticated: false },
        } as Partial<ProviderDiagnosticSample>)}
      />
    )
    expect(screen.getByText("status.invalid")).toBeInTheDocument()

    rerender(
      <SummarySection
        providerName="OpenAI"
        latestSample={sample({
          probe: { authenticated: true },
        } as Partial<ProviderDiagnosticSample>)}
      />
    )
    expect(screen.getByText("status.verified")).toBeInTheDocument()
  })

  it("marks execution completed only when the sample itself completed", () => {
    const { rerender } = render(
      <SummarySection providerName="OpenAI" latestSample={sample({ status: "completed" })} />
    )
    expect(screen.getByText("status.completed")).toBeInTheDocument()

    rerender(<SummarySection providerName="OpenAI" latestSample={sample({ status: "failed" })} />)
    expect(screen.queryByText("status.completed")).not.toBeInTheDocument()
  })

  it("renders flat — no card frame around the tiles", () => {
    const { container } = render(<SummarySection providerName="OpenAI" />)
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    expect(screen.getByTestId("diagnostics-summary")).toBeInTheDocument()
  })
})
