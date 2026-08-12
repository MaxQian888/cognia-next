/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("motion/react", () => jest.requireActual("../../__mocks__/motion-react.js"))

jest.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <svg>{children}</svg>,
  Area: () => <path />,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: ({
    labelFormatter,
    formatter,
  }: {
    labelFormatter?: (value: string) => string
    formatter?: (value: number) => [string, string]
  }) => (
    <div>
      {labelFormatter?.("2026-08-11T08:42:00.000Z")}
      {formatter?.(182)[0]}
    </div>
  ),
}))

import { createPreviewStatusSnapshot } from "@/lib/status/public-status"
import { PublicStatusPage } from "./public-status-page"

describe("PublicStatusPage", () => {
  it("renders the degraded preview with explicit, accessible service history", () => {
    render(<PublicStatusPage snapshot={createPreviewStatusSnapshot()} />)

    expect(screen.getByText("Preview data")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Partially degraded service")
    expect(screen.getByRole("heading", { name: "Service health" })).toBeInTheDocument()
    expect(screen.getAllByTestId("availability-day")).toHaveLength(450)
    expect(
      screen.getByLabelText(/Agent Runtime on Aug 11, 2026: Degraded, 99.18% uptime/)
    ).toBeInTheDocument()
    expect(screen.getByText("99.98%", { exact: false })).toBeInTheDocument()
  })

  it("expands a service row to show latency and regional health", () => {
    render(<PublicStatusPage snapshot={createPreviewStatusSnapshot()} />)

    const trigger = screen.getByRole("button", { name: "View details for Agent Runtime" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("heading", { name: "24-hour response time" })).toBeInTheDocument()
    expect(screen.getByText("Asia Pacific")).toBeInTheDocument()
    expect(screen.getByText("306 ms")).toBeInTheDocument()
  })

  it("presents active incident updates newest first and scheduled maintenance", () => {
    render(<PublicStatusPage snapshot={createPreviewStatusSnapshot()} />)

    const incident = screen.getByRole("article", { name: "Elevated job start latency in APAC" })
    expect(
      within(incident)
        .getAllByTestId("incident-update-state")
        .map((node) => node.textContent)
    ).toEqual(["Monitoring", "Identified", "Investigating"])
    expect(screen.getByRole("heading", { name: "Scheduled maintenance" })).toBeInTheDocument()
    expect(screen.getByText("Control plane database maintenance")).toBeInTheDocument()
  })

  it("renders an all-operational state without an active incident", () => {
    render(<PublicStatusPage snapshot={createPreviewStatusSnapshot("operational")} />)

    expect(screen.getByRole("status")).toHaveTextContent("All systems operational")
    expect(screen.getByText("No active incidents")).toBeInTheDocument()
    expect(screen.queryByRole("article", { name: "Elevated job start latency in APAC" })).toBeNull()
  })

  it("makes the subscription interaction explicitly non-persistent", () => {
    render(<PublicStatusPage snapshot={createPreviewStatusSnapshot()} />)

    fireEvent.click(screen.getAllByRole("button", { name: "Subscribe to updates" })[0])
    const dialog = screen.getByRole("dialog", { name: "Subscribe to status updates" })
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Email address" }), {
      target: { value: "operator@example.com" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview subscription" }))

    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Preview only — no subscription was created."
    )

    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0])
    expect(screen.queryByRole("dialog", { name: "Subscribe to status updates" })).toBeNull()
  })
})
