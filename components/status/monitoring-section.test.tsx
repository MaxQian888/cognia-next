import { render, screen, within } from "@testing-library/react"

import { createStatusFixture } from "@/lib/status/fixtures"
import type { ProbeSummary } from "@/lib/status/public-status"

import { MonitoringSection } from "./monitoring-section"

const external: ProbeSummary = {
  id: "ext-1",
  label: { en: "External probe", "zh-CN": "外部探针" },
  source: "external",
  location: { en: "Frankfurt, Germany" },
  provider: "Hetzner",
  profiles: [
    { id: "native", cadenceSeconds: 60, simulatedOrigin: false },
    { id: "ios", cadenceSeconds: 300, simulatedOrigin: true },
  ],
  reference: true,
  enrolledAt: "2026-09-01T00:00:00.000Z",
  lastAttemptAt: "2026-10-02T09:59:00.000Z",
  lastSuccessAt: null,
  health: "error",
  reason: "runner_error",
}

describe("MonitoringSection", () => {
  it("lists observers with location, provider, health, cadence and last attempt/success", () => {
    render(<MonitoringSection probes={[external]} monitoringStatus="degraded" />)
    const card = screen.getByTestId("probe-card")
    expect(within(card).getByText("External probe")).toBeInTheDocument()
    expect(card).toHaveTextContent("Frankfurt, Germany")
    expect(card).toHaveTextContent("Hosted on Hetzner")
    expect(within(card).getByText("Error")).toBeInTheDocument()
    expect(within(card).getByText("Reference observer")).toBeInTheDocument()
    expect(card).toHaveTextContent("Native every 60 s")
    expect(card).toHaveTextContent("iOS every 300 s")
    expect(card).toHaveTextContent("Simulated client Origin header, not a real device")
    expect(card).toHaveTextContent(/Last attempt Oct 2, 2026/)
    expect(card).toHaveTextContent("Last success never")
    expect(card).toHaveTextContent("Probe runner error")
  })

  it("explains how much coverage there is and what it does not promise", () => {
    const snapshot = createStatusFixture("operational")
    render(
      <MonitoringSection probes={snapshot.probes} monitoringStatus={snapshot.monitoringStatus} />
    )
    expect(screen.getByTestId("monitoring-coverage")).toHaveTextContent(
      "Observed from 1 location. This is not a global or mobile-network guarantee."
    )
    expect(screen.getByText("Location not declared")).toBeInTheDocument()
    expect(screen.getAllByText("Single observer").length).toBeGreaterThan(0)
  })

  it("says nothing is measured before any observer is enrolled", () => {
    render(<MonitoringSection probes={[]} monitoringStatus="unknown" />)
    expect(screen.getByTestId("monitoring-coverage")).toHaveTextContent(
      "Observed from no locations."
    )
    expect(
      screen.getByText("No observer is enrolled yet, so nothing is being measured.")
    ).toBeInTheDocument()
  })

  it("does not count disabled observers as coverage", () => {
    render(
      <MonitoringSection
        probes={[{ ...external, health: "disabled" }]}
        monitoringStatus="unknown"
      />
    )
    expect(screen.getByTestId("monitoring-coverage")).toHaveTextContent(
      "Observed from no locations."
    )
  })
})
