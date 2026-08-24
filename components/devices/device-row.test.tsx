import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"

import { DeviceRowButton } from "./device-row"

const NOW = 1_700_000_000_000

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Max's iPhone",
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: NOW, source: "request" },
    lastSeenAt: NOW,
    appVersion: "1.2.3",
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

describe("DeviceRowButton", () => {
  it("shows the label and the app version for a paired device", () => {
    render(<DeviceRowButton row={row()} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("Max's iPhone")).toBeInTheDocument()
    expect(screen.getByText("v1.2.3")).toBeInTheDocument()
  })

  it("shows the base URL for a remote host, which is what identifies it", () => {
    render(
      <DeviceRowButton
        row={row({ kind: "remote-host", baseUrl: "https://build.local", appVersion: undefined })}
        selected={false}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByText("https://build.local")).toBeInTheDocument()
  })

  it("selects on click", async () => {
    const onSelect = jest.fn()
    render(<DeviceRowButton row={row()} selected={false} onSelect={onSelect} />)
    await userEvent.click(screen.getByTestId("device-row-device:a"))
    expect(onSelect).toHaveBeenCalledWith("device:a")
  })

  it("marks the selected row for assistive tech, not just visually", () => {
    render(<DeviceRowButton row={row()} selected onSelect={jest.fn()} />)
    expect(screen.getByTestId("device-row-device:a")).toHaveAttribute("aria-current", "true")
  })

  it("shows no lifecycle badge while a device is active", () => {
    render(<DeviceRowButton row={row()} selected={false} onSelect={jest.fn()} />)
    expect(screen.queryByText("Active")).not.toBeInTheDocument()
  })

  it("shows the lifecycle badge once it stops being active", () => {
    render(
      <DeviceRowButton row={row({ adminState: "paused" })} selected={false} onSelect={jest.fn()} />
    )
    expect(screen.getByText("Paused")).toBeInTheDocument()
  })

  /**
   * A device the host and the mirror disagree about is the case the old card
   * could not show at all — it read "active" while every call was refused.
   */
  it("flags a host/mirror disagreement as needing attention", () => {
    render(
      <DeviceRowButton
        row={row({ adminStateConflict: true })}
        selected={false}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByLabelText("Needs attention")).toBeInTheDocument()
  })

  it("flags a degraded host connection the same way", () => {
    render(
      <DeviceRowButton
        row={row({ kind: "remote-host", connectionState: "degraded" })}
        selected={false}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByLabelText("Needs attention")).toBeInTheDocument()
  })

  it("does not flag a healthy device", () => {
    render(<DeviceRowButton row={row()} selected={false} onSelect={jest.fn()} />)
    expect(screen.queryByLabelText("Needs attention")).not.toBeInTheDocument()
  })

  it("labels this machine instead of pretending to have last seen it", () => {
    render(
      <DeviceRowButton
        row={row({ kind: "local", isSelf: true, label: "This Mac" })}
        selected={false}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getAllByText("This device").length).toBeGreaterThan(0)
  })
})
