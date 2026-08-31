import { render, screen } from "@testing-library/react"

import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { DeviceDetail } from "./device-detail"

// The sections are covered by their own suites; here they stand in as markers
// so the assertions are about composition — which cards appear, in what order
// — rather than about anything they render.
jest.mock("./sections/overview-section", () => ({
  OverviewSection: () => <div data-testid="section-overview" />,
}))
jest.mock("./sections/capabilities-section", () => ({
  CapabilitiesSection: () => <div data-testid="section-capabilities" />,
}))
jest.mock("./sections/access-section", () => ({
  AccessSection: () => <div data-testid="section-access" />,
}))
jest.mock("./sections/runtime-section", () => ({
  RuntimeSection: () => <div data-testid="section-runtime" />,
}))
jest.mock("./sections/activity-section", () => ({
  ActivitySection: () => <div data-testid="section-activity" />,
}))
jest.mock("./sections/wan-section", () => ({
  WanSection: () => <div data-testid="section-wan" />,
}))
jest.mock("./host-controls", () => ({
  HostControls: () => <div data-testid="section-host-controls" />,
}))

const actions = {} as DeviceGrantActions

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Max's iPhone",
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

describe("DeviceDetail", () => {
  it("explains an empty pane instead of rendering blank chrome", () => {
    render(<DeviceDetail row={null} actions={actions} />)
    expect(screen.getByTestId("device-detail-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("device-detail")).not.toBeInTheDocument()
  })

  it("heads the pane with the device's identity", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    expect(screen.getByTestId("device-hero")).toBeInTheDocument()
    expect(screen.getByText("Max's iPhone")).toBeInTheDocument()
  })

  /**
   * The point of dropping the tab bar: every section is on the page at once,
   * so nothing is discoverable only by clicking. A regression here would most
   * likely be a section quietly gated behind a condition.
   */
  it("renders every section at once, with no tab bar", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    for (const id of ["overview", "capabilities", "wan", "access", "runtime", "activity"]) {
      expect(screen.getByTestId(`section-${id}`)).toBeInTheDocument()
    }
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })

  /**
   * These two are about the machine rather than about any one question, so
   * they sit above the grid instead of inside a card — and they must not be
   * inside a section that could be scrolled past.
   */
  it("raises a host/mirror lifecycle disagreement above the grid", () => {
    render(<DeviceDetail row={row({ adminStateConflict: true })} actions={actions} />)
    expect(screen.getByTestId("device-admin-conflict")).toBeInTheDocument()
  })

  it("surfaces a host's last connection error instead of swallowing it", () => {
    render(
      <DeviceDetail
        row={row({ kind: "remote-host", connectionError: "handshake refused" })}
        actions={actions}
      />
    )
    expect(screen.getByText("handshake refused")).toBeInTheDocument()
  })

  it("stays quiet when there is nothing wrong", () => {
    render(<DeviceDetail row={row()} actions={actions} />)
    expect(screen.queryByTestId("device-admin-conflict")).not.toBeInTheDocument()
  })

  /**
   * One scroll means the offset is shared across devices. Landing mid-way
   * through a different machine's dashboard, with no signal that is what
   * happened, is the failure this guards.
   */
  it("returns to the top when the selected device changes", () => {
    const { container, rerender } = render(<DeviceDetail row={row()} actions={actions} />)
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")
    expect(scroller).not.toBeNull()

    scroller!.scrollTop = 220
    rerender(<DeviceDetail row={row({ ref: "device:b" })} actions={actions} />)
    expect(scroller!.scrollTop).toBe(0)

    // Re-rendering the same device must not yank the reader back up.
    scroller!.scrollTop = 220
    rerender(<DeviceDetail row={row({ ref: "device:b", label: "Renamed" })} actions={actions} />)
    expect(scroller!.scrollTop).toBe(220)
  })
})
