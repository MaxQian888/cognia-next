import { render, screen } from "@testing-library/react"

import type { DeviceRow } from "@/lib/devices/types"

import { OverviewTab } from "./overview-tab"

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

describe("OverviewTab", () => {
  /**
   * The case the old card could not show at all: a device suspended through
   * the CLI or the Owner API read "active" while every call from it was
   * refused.
   */
  it("warns when the host and the local record disagree", () => {
    render(<OverviewTab row={row({ adminState: "paused", adminStateConflict: true })} />)
    expect(screen.getByTestId("device-admin-conflict")).toBeInTheDocument()
    expect(screen.getByText(/stale/)).toBeInTheDocument()
  })

  it("stays quiet when they agree", () => {
    render(<OverviewTab row={row({ adminState: "paused" })} />)
    expect(screen.queryByTestId("device-admin-conflict")).not.toBeInTheDocument()
  })

  /**
   * `device-presence-registry` has maintained this since remote attach landed,
   * with a docblock saying no surface renders it.
   */
  it("renders live event-plane state and open streams", () => {
    render(
      <OverviewTab
        row={row({
          presence: {
            eventPlane: "ready",
            attention: "foreground",
            streams: [{ leaseId: "l1", transport: "ws", state: "ready", openedAt: 1 }],
          },
        })}
      />
    )
    const plane = screen.getByTestId("device-event-plane")
    expect(plane).toBeInTheDocument()
    expect(screen.getByText("In the foreground")).toBeInTheDocument()
    expect(screen.getByText("ws")).toBeInTheDocument()
  })

  it("says so when the event plane is known but no stream is open", () => {
    render(
      <OverviewTab
        row={row({ presence: { eventPlane: "disconnected", attention: "unknown", streams: [] } })}
      />
    )
    expect(screen.getByText("No event stream is open right now.")).toBeInTheDocument()
  })

  it("omits the presence section entirely when nothing is known", () => {
    render(<OverviewTab row={row()} />)
    expect(screen.queryByTestId("device-event-plane")).not.toBeInTheDocument()
  })

  it("surfaces a host's last connection error instead of swallowing it", () => {
    render(
      <OverviewTab
        row={row({ kind: "remote-host", connectionError: "host_capabilities reply had no array" })}
      />
    )
    expect(screen.getByText("host_capabilities reply had no array")).toBeInTheDocument()
  })

  it("shortens the fingerprint but keeps the full value reachable", () => {
    const fingerprint = `${"a".repeat(56)}deadbeef`
    render(<OverviewTab row={row({ fingerprint })} />)
    const shortened = screen.getByTitle(fingerprint)
    expect(shortened).toHaveTextContent("aaaaaaaaaaaa…deadbeef")
    expect(screen.getByTestId("copy-fingerprint")).toBeInTheDocument()
  })

  it("labels this machine rather than claiming a last-seen time for it", () => {
    render(<OverviewTab row={row({ kind: "local", isSelf: true })} />)
    expect(screen.getAllByText("This device").length).toBeGreaterThan(0)
  })
})
