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
  describe("connection-test source note", () => {
    it("says a failed connection test is where the Error status comes from", () => {
      render(
        <SummarySection
          providerName="Anthropic"
          connectionTest={{ success: false, error: "Failed to fetch", testedAt: 10 }}
        />
      )
      const note = screen.getByTestId("diagnostics-summary-connection-test")
      expect(note).toHaveAttribute("data-outcome", "failed")
      expect(note).toHaveTextContent(/summary\.connectionTestFailedWithError.*Failed to fetch/)
      // The tiles still speak only for diagnostic runs.
      expect(screen.getAllByText("status.unverified")).toHaveLength(2)
    })

    it("uses the generic failure copy when the test carried no message", () => {
      render(<SummarySection providerName="Anthropic" connectionTest={{ success: false }} />)
      expect(screen.getByTestId("diagnostics-summary-connection-test")).toHaveTextContent(
        "summary.connectionTestFailed"
      )
    })

    it("notes a passed test so Unverified tiles do not read as a failure", () => {
      render(
        <SummarySection providerName="Anthropic" connectionTest={{ success: true, testedAt: 5 }} />
      )
      expect(screen.getByTestId("diagnostics-summary-connection-test")).toHaveAttribute(
        "data-outcome",
        "passed"
      )
    })

    it("stays quiet when a diagnostic run is newer than the connection test", () => {
      render(
        <SummarySection
          providerName="Anthropic"
          latestSample={sample({ startedAt: 20, completedAt: 30 })}
          connectionTest={{ success: false, error: "old", testedAt: 10 }}
        />
      )
      expect(screen.queryByTestId("diagnostics-summary-connection-test")).not.toBeInTheDocument()
    })

    it("stays quiet with no connection test", () => {
      render(<SummarySection providerName="Anthropic" connectionTest={null} />)
      expect(screen.queryByTestId("diagnostics-summary-connection-test")).not.toBeInTheDocument()
    })
  })
})
