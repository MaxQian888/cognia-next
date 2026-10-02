import { fireEvent, render, screen } from "@testing-library/react"

import { createStatusFixture } from "@/lib/status/fixtures"
import type { PublicStatusSnapshot, SnapshotFreshness } from "@/lib/status/public-status"

import { StatusHero, type StatusHeroProps } from "./status-hero"

const fresh: SnapshotFreshness = { ageMs: 20_000, stale: false, clockUncertain: false }

function renderHero(overrides: Partial<StatusHeroProps> = {}) {
  const props: StatusHeroProps = {
    snapshot: createStatusFixture("operational", "90d"),
    freshness: fresh,
    range: "90d",
    ranges: ["24h", "7d", "30d", "90d"],
    onRangeChange: jest.fn(),
    pendingRange: false,
    failure: null,
    onRetry: jest.fn(),
    refreshing: false,
    ...overrides,
  }
  render(<StatusHero {...props} />)
  return props
}

describe("StatusHero", () => {
  it("shows a skeleton, not a status, before the first snapshot", () => {
    renderHero({ snapshot: null, freshness: null, pendingRange: true })
    expect(screen.getByTestId("hero-skeleton")).toBeInTheDocument()
    expect(screen.queryByTestId("overall-status")).toBeNull()
    expect(screen.getByTestId("last-updated")).toHaveTextContent("No data received yet")
  })

  it("shows the live overall status, monitoring, availability and coverage for the range", () => {
    const snapshot = createStatusFixture("operational", "90d")
    renderHero({ snapshot })
    expect(screen.getByRole("status")).toHaveTextContent("All components operational")
    expect(screen.getByTestId("overall-status")).toHaveAttribute("data-status", "operational")
    expect(screen.getByTestId("monitoring-status")).toHaveTextContent("Limited")
    expect(screen.getByTestId("monitoring-status")).toHaveTextContent("Single observer")
    expect(screen.getByText("Last 90 days")).toBeInTheDocument()
    expect(screen.getByTestId("overall-availability")).toHaveTextContent(/^\d+\.\d{2}%$/)
    expect(screen.getByTestId("overall-coverage")).toHaveTextContent(/^\d+\.\d{2}%$/)
    expect(screen.getByTestId("last-updated")).toHaveTextContent("Updated just now")
    expect(screen.getAllByTestId("history-cell")).toHaveLength(90)
  })

  it("never shows 100 % or green for a service nobody measures", () => {
    renderHero({ snapshot: createStatusFixture("empty", "90d") })
    expect(screen.getByTestId("overall-status")).toHaveAttribute("data-status", "unknown")
    expect(screen.getByRole("status")).toHaveTextContent("Status unknown")
    expect(screen.getByTestId("overall-availability")).toHaveTextContent("No data")
    expect(screen.getByTestId("overall-coverage")).toHaveTextContent("No data")
  })

  it("shows a stale snapshot as last reported, out of date, and not green", () => {
    renderHero({ freshness: { ageMs: 10 * 60_000, stale: true, clockUncertain: false } })
    const pill = screen.getByTestId("overall-status")
    expect(pill).toHaveAttribute("data-stale", "true")
    expect(pill).toHaveTextContent("Last reported: All components operational")
    expect(pill.className).not.toMatch(/emerald/)
    expect(screen.getByTestId("freshness-warning")).toHaveTextContent("Out of date")
    expect(screen.getByTestId("freshness-warning")).toHaveTextContent("more than 3 minutes old")
    expect(screen.getByTestId("last-updated")).toHaveTextContent("Updated 10 minutes ago")
  })

  it("says freshness is uncertain when the clocks disagree", () => {
    renderHero({ freshness: { ageMs: 0, stale: true, clockUncertain: true } })
    expect(screen.getByTestId("freshness-warning")).toHaveTextContent("Freshness uncertain")
  })

  it("shows unknown with a retry when no snapshot could be loaded", () => {
    const props = renderHero({
      snapshot: null,
      freshness: null,
      failure: { kind: "network", failures: 2, at: 0 },
    })
    expect(screen.getByTestId("overall-status")).toHaveAttribute("data-status", "unknown")
    expect(screen.getByTestId("status-unavailable")).toHaveTextContent(
      "The status service could not be reached."
    )
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(props.onRetry).toHaveBeenCalled()
  })

  it("asks for a reload, not a preview, when the data format is unsupported", () => {
    renderHero({
      snapshot: null,
      freshness: null,
      failure: { kind: "unsupported", failures: 1, at: 0 },
    })
    expect(screen.getByTestId("status-unavailable")).toHaveTextContent("newer data format")
    expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument()
    expect(screen.queryByText(/preview/i)).toBeNull()
  })

  it("reports maintenance exclusions next to the availability", () => {
    const snapshot: PublicStatusSnapshot = createStatusFixture("operational", "90d")
    snapshot.overall.availability = { ...snapshot.overall.availability, excludedSlots: 30 }
    renderHero({ snapshot })
    expect(screen.getByText(/30 maintenance minutes excluded/)).toBeInTheDocument()
  })

  it("passes range changes up", () => {
    const props = renderHero()
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }))
    expect(props.onRangeChange).toHaveBeenCalledWith("7d")
  })
})
