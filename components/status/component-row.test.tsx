jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <svg>{children}</svg>,
  Line: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { createStatusFixture } from "@/lib/status/fixtures"

import { ComponentRow } from "./component-row"

describe("ComponentRow", () => {
  it("names the component, says what its check proves and shows status, confidence and history", () => {
    const snapshot = createStatusFixture("degraded", "30d")
    const relay = snapshot.components.find((item) => item.id === "relayData")!
    render(<ComponentRow component={relay} range="30d" probes={snapshot.probes} stale={false} />)
    expect(screen.getByRole("heading", { name: "Relay data lane" })).toBeInTheDocument()
    expect(screen.getByText(/explicit data lane and check they arrive intact/)).toBeInTheDocument()
    expect(screen.getByText("Degraded")).toHaveAttribute("data-status", "degraded")
    expect(screen.getByText("Single observer")).toBeInTheDocument()
    expect(screen.getAllByTestId("history-cell")).toHaveLength(30)
    expect(screen.getByTestId("component-availability")).toHaveTextContent(
      /^Availability \d+\.\d{2}% · Coverage \d+\.\d{2}%$/
    )
  })

  it("expands to the phase definition, latency and evidence", () => {
    const snapshot = createStatusFixture("operational", "24h")
    const http = snapshot.components[0]!
    render(<ComponentRow component={http} range="24h" probes={snapshot.probes} stale={false} />)
    const trigger = screen.getByRole("button", { name: "Show details for Signaling HTTP" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(trigger)
    expect(screen.getByRole("button", { name: "Hide details for Signaling HTTP" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(
      screen.getByText(/HTTP latency: time to receive a complete health response/)
    ).toBeVisible()
    expect(screen.getByTestId("latency-summary")).toBeVisible()
    expect(screen.getByText("Cloudflare scheduled check")).toBeVisible()
  })

  it("drops the colour of a stale status", () => {
    const snapshot = createStatusFixture("operational", "7d")
    render(
      <ComponentRow component={snapshot.components[0]!} range="7d" probes={snapshot.probes} stale />
    )
    expect(screen.getByText("Operational · not current")).toHaveAttribute("data-stale", "true")
  })

  it("shows no availability figure for a component nobody has measured", () => {
    const snapshot = createStatusFixture("empty", "7d")
    render(
      <ComponentRow component={snapshot.components[0]!} range="7d" probes={[]} stale={false} />
    )
    expect(screen.getByText("Unknown")).toBeInTheDocument()
    expect(screen.getByText("No evidence")).toBeInTheDocument()
    expect(screen.getByTestId("component-availability")).toHaveTextContent(
      "Availability No data · Coverage No data"
    )
    expect(screen.getByText("No evidence yet")).toBeInTheDocument()
  })

  it("flags a component under maintenance", () => {
    const snapshot = createStatusFixture("maintenance", "7d")
    const auth = snapshot.components.find((item) => item.id === "signalingAuth")!
    render(<ComponentRow component={auth} range="7d" probes={snapshot.probes} stale={false} />)
    expect(screen.getAllByText("Under maintenance").length).toBeGreaterThan(0)
  })
})
