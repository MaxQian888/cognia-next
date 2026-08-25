import { render, screen } from "@testing-library/react"

import type { DeviceRow } from "@/lib/devices/types"

import { OverviewSection } from "./overview-section"

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Phone",
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

describe("OverviewSection", () => {
  /**
   * The device-wide alerts (a host/mirror lifecycle disagreement, a failed
   * connection attempt) moved up to `device-detail`: they are facts about the
   * machine rather than answers to any one section's question, and burying
   * one inside a card that can be scrolled past is how it goes unread.
   * `device-detail.test.tsx` owns them now.
   */
  it("still states the lifecycle the host is enforcing", () => {
    render(<OverviewSection row={row({ adminState: "paused", adminStateConflict: true })} />)
    expect(screen.getByText("Paused")).toBeInTheDocument()
  })

  /**
   * `device-presence-registry` has maintained this since remote attach landed,
   * with a docblock saying no surface renders it.
   */
  it("renders live event-plane state and open streams", () => {
    render(
      <OverviewSection
        row={row({
          presence: {
            eventPlane: "ready",
            attention: "foreground",
            streams: [{ leaseId: "l1", transport: "ws", state: "ready", openedAt: 1 }],
          },
        })}
      />
    )
    const plane = screen.getByTestId("device-section-event-plane")
    expect(plane).toBeInTheDocument()
    expect(screen.getByText("In the foreground")).toBeInTheDocument()
    expect(screen.getByText("ws")).toBeInTheDocument()
  })

  it("says so when the event plane is known but no stream is open", () => {
    render(
      <OverviewSection
        row={row({ presence: { eventPlane: "disconnected", attention: "unknown", streams: [] } })}
      />
    )
    expect(screen.getByText("No event stream is open right now.")).toBeInTheDocument()
  })

  it("omits the presence section entirely when nothing is known", () => {
    render(<OverviewSection row={row()} />)
    expect(screen.queryByTestId("device-section-event-plane")).not.toBeInTheDocument()
  })

  it("shortens the fingerprint but keeps the full value reachable", () => {
    const fingerprint = `${"a".repeat(56)}deadbeef`
    render(<OverviewSection row={row({ fingerprint })} />)
    const shortened = screen.getByTitle(fingerprint)
    expect(shortened).toHaveTextContent("aaaaaaaaaaaa…deadbeef")
    expect(screen.getByTestId("copy-fingerprint")).toBeInTheDocument()
  })

  it("labels this machine rather than claiming a last-seen time for it", () => {
    render(<OverviewSection row={row({ kind: "local", isSelf: true })} />)
    expect(screen.getAllByText("This device").length).toBeGreaterThan(0)
  })
})

describe("device ownership (ADR-0149 §5, step one)", () => {
  it("names the person a paired device belongs to", () => {
    render(
      <OverviewSection
        row={row({
          kind: "paired-device",
          ownerUserId: "usr_ada000000000000000000",
          ownerLabel: "Ada",
        })}
      />
    )
    expect(screen.getByText("Belongs to")).toBeInTheDocument()
    expect(screen.getByText("Ada")).toBeInTheDocument()
  })

  it("falls back to the id when no name is mirrored", () => {
    // "Unknown person" would be a worse answer than an id you can search for.
    render(
      <OverviewSection
        row={row({ kind: "paired-device", ownerUserId: "usr_ada000000000000000000" })}
      />
    )
    expect(screen.getByText("usr_ada000000000000000000")).toBeInTheDocument()
  })

  it("says a paired device is unclaimed rather than omitting the row", () => {
    render(<OverviewSection row={row({ kind: "paired-device" })} />)
    expect(screen.getByText("Unclaimed")).toBeInTheDocument()
  })

  it("says nothing about ownership for this machine", () => {
    // The local device is not a paired device and has no owner to report.
    render(<OverviewSection row={row({ kind: "local", isSelf: true })} />)
    expect(screen.queryByText("Belongs to")).not.toBeInTheDocument()
  })
})
