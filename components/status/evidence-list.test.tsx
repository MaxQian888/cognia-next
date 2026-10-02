import { render, screen, within } from "@testing-library/react"

import { createStatusFixture } from "@/lib/status/fixtures"
import type { EvidenceSummary, ProbeSummary } from "@/lib/status/public-status"

import { EvidenceList } from "./evidence-list"

const probe: ProbeSummary = {
  id: "ext-fra",
  label: { en: "External probe", "zh-CN": "外部探针" },
  source: "external",
  location: { en: "Frankfurt", "zh-CN": "法兰克福" },
  provider: "Hetzner",
  profiles: [{ id: "android", cadenceSeconds: 300, simulatedOrigin: true }],
  reference: false,
  enrolledAt: "2026-09-01T00:00:00.000Z",
  lastAttemptAt: "2026-10-02T09:59:00.000Z",
  lastSuccessAt: "2026-10-02T09:40:00.000Z",
  health: "healthy",
  reason: null,
}

const failing: EvidenceSummary = {
  probeId: "ext-fra",
  profileId: "android",
  source: "external",
  reference: false,
  result: "fail",
  reason: "origin_rejected",
  checkedAt: "2026-10-02T09:59:00.000Z",
  fresh: false,
  consecutiveFailures: 3,
  simulatedOrigin: true,
}

describe("EvidenceList", () => {
  it("shows source, profile, result, translated reason, time and freshness per observer", () => {
    render(<EvidenceList evidence={[failing]} probes={[probe]} />)
    const row = screen.getByTestId("evidence-row")
    expect(within(row).getByText("External probe")).toBeInTheDocument()
    expect(within(row).getByText("External")).toBeInTheDocument()
    expect(within(row).getByText("Android")).toBeInTheDocument()
    expect(row).toHaveTextContent("Fail")
    expect(row).toHaveTextContent("Origin rejected")
    expect(within(row).getByText("Stale")).toBeInTheDocument()
    expect(row).toHaveTextContent("3 consecutive failures")
    expect(row).toHaveTextContent(/Checked Oct 2, 2026/)
    expect(
      within(row).getByText("Simulated client Origin header, not a real device")
    ).toBeInTheDocument()
  })

  it("labels the reference observer and falls back to the probe id when unregistered", () => {
    const evidence = createStatusFixture("operational").components[0]!.evidence
    render(<EvidenceList evidence={evidence} probes={[]} />)
    expect(screen.getByText("cf-cron")).toBeInTheDocument()
    expect(screen.getByText("Reference")).toBeInTheDocument()
    expect(screen.getByText("Cloudflare")).toBeInTheDocument()
    expect(screen.getByText("Fresh")).toBeInTheDocument()
  })

  it("says when there is no evidence", () => {
    render(<EvidenceList evidence={[]} probes={[]} />)
    expect(
      screen.getByText("No observer has reported evidence for this check yet.")
    ).toBeInTheDocument()
  })
})
