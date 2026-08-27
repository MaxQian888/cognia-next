/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import { applyTimeline, createIncident, type SreIncident } from "../incident/model"
import { PhaseStrip } from "./phase-strip"

const ROW = {
  time: "12:02",
  component: "gateway",
  event: "timeout",
  signals: [],
  evidenceIds: ["log_003"],
  sources: ["logs" as const],
  confidence: 0.9,
  flags: [],
}

function incident(): SreIncident {
  return createIncident({
    id: "inc",
    now: "2026-08-04T12:10:00.000Z",
    title: "t",
    environment: "prod",
    window: { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" },
  })
}

describe("PhaseStrip", () => {
  it("labels every phase in the wide form", () => {
    render(<PhaseStrip incident={incident()} />)
    for (const label of ["Scope", "Evidence", "Attribution", "Conclusion"]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByTestId("sre-phase-strip")).toHaveAttribute("data-phase", "scope")
  })

  it("keeps only the current label in the narrow form", () => {
    render(<PhaseStrip incident={incident()} compact />)
    expect(screen.getByText("Scope")).toBeInTheDocument()
    expect(screen.queryByText("Attribution")).not.toBeInTheDocument()
  })

  it("moves with the incident rather than a stored field", () => {
    render(<PhaseStrip incident={applyTimeline(incident(), { rows: [ROW] }, "now")} compact />)
    expect(screen.getByTestId("sre-phase-strip")).toHaveAttribute("data-phase", "attribution")
    expect(screen.getByText("Attribution")).toBeInTheDocument()
  })

  it("exposes the steps as a labelled list for assistive tech", () => {
    render(<PhaseStrip incident={incident()} />)
    expect(screen.getByRole("list", { name: "Investigation phase" })).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(4)
  })
})
