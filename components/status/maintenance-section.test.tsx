import { render, screen, within } from "@testing-library/react"

import { FIXTURE_MAINTENANCE } from "@/lib/status/fixtures"
import type { MaintenanceView } from "@/lib/status/public-status"

import { MaintenanceSection, visibleMaintenance } from "./maintenance-section"

const scheduled: MaintenanceView = {
  ...FIXTURE_MAINTENANCE,
  startsAt: "2026-10-04T10:00:00.000Z",
  endsAt: "2026-10-04T11:00:00.000Z",
}

describe("visibleMaintenance", () => {
  it("keeps current and upcoming windows, in-progress first, and drops finished ones", () => {
    const windows: MaintenanceView[] = [
      { ...scheduled, id: "later", startsAt: "2026-10-09T00:00:00.000Z" },
      { ...scheduled, id: "done", state: "completed" },
      { ...scheduled, id: "dropped", state: "cancelled" },
      { ...scheduled, id: "now", state: "in_progress" },
      { ...scheduled, id: "soon" },
      { ...scheduled, id: "confirm", state: "awaiting_confirmation" },
    ]
    expect(visibleMaintenance(windows).map((item) => item.id)).toEqual([
      "now",
      "confirm",
      "soon",
      "later",
    ])
  })
})

describe("MaintenanceSection", () => {
  it("shows the window in UTC and local time with scope and exclusion rule", () => {
    render(<MaintenanceSection maintenance={[scheduled]} />)
    const article = screen.getByRole("article", { name: "Relay runtime upgrade" })
    expect(within(article).getByText("Scheduled")).toBeInTheDocument()
    expect(article).toHaveTextContent("Signaling sessions may reconnect once during the window.")
    expect(article).toHaveTextContent("Affects: Authenticated signaling and Relay data lane")
    expect(within(article).getByTestId("maintenance-utc")).toHaveTextContent(
      /Oct 4, 2026.*10:00 – Oct 4, 2026.*11:00 UTC/
    )
    expect(article).toHaveTextContent("Your time:")
    expect(article).toHaveTextContent("excluded from maintenance-adjusted availability")
  })

  it("shows the latest operator note", () => {
    render(
      <MaintenanceSection
        maintenance={[
          {
            ...scheduled,
            state: "in_progress",
            updates: [
              {
                id: "u1",
                kind: "started",
                message: { en: "Started." },
                at: "2026-10-04T10:00:00.000Z",
              },
              {
                id: "u2",
                kind: "extended",
                message: { en: "Extended by 30 minutes." },
                at: "2026-10-04T10:50:00.000Z",
              },
            ],
          },
        ]}
      />
    )
    expect(screen.getByText("Extended by 30 minutes.")).toBeInTheDocument()
    expect(screen.queryByText("Started.")).toBeNull()
  })

  it("says when nothing is planned", () => {
    render(<MaintenanceSection maintenance={[{ ...scheduled, state: "completed" }]} />)
    expect(screen.getByText("No maintenance scheduled.")).toBeInTheDocument()
  })
})
