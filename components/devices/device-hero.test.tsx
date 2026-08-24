import { render, screen } from "@testing-library/react"

import type { DeviceRow } from "@/lib/devices/types"

import { DeviceHero } from "./device-hero"

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Max's iPhone",
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    lastSeenAt: Date.now() - 20_000,
    appVersion: "1.4.2",
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

describe("DeviceHero", () => {
  it("names the device, its kind and its reachability", () => {
    render(<DeviceHero row={row()} />)
    expect(screen.getByRole("heading", { name: "Max's iPhone" })).toBeInTheDocument()
    expect(screen.getByText("Paired device")).toBeInTheDocument()
    expect(screen.getByText("Online")).toBeInTheDocument()
  })

  it("shows a host's address where another kind shows its version", () => {
    const { rerender } = render(<DeviceHero row={row()} />)
    expect(screen.getByText("v1.4.2")).toBeInTheDocument()

    rerender(<DeviceHero row={row({ kind: "remote-host", baseUrl: "https://build.local:8443" })} />)
    expect(screen.getByText("https://build.local:8443")).toBeInTheDocument()
  })

  /**
   * "Last seen 3 seconds ago" under the name of the machine you are sitting
   * at is noise dressed as a fact.
   */
  it("omits a last-seen time for this machine", () => {
    render(<DeviceHero row={row({ kind: "local", isSelf: true, label: "This Mac" })} />)
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
  })

  it("renders a stat per answerable question and nothing for the rest", () => {
    render(
      <DeviceHero
        row={row({
          capabilities: [
            { id: "camera", group: "platform", state: "reported", source: "device-report" },
            { id: "ocr", group: "platform", state: "absent", source: "device-report" },
          ],
        })}
      />
    )
    expect(screen.getByTestId("device-stat-capabilities")).toHaveTextContent("1/2")
    // A phone with no grants loaded and no tiers gets neither slot.
    expect(screen.queryByTestId("device-stat-grants")).not.toBeInTheDocument()
    expect(screen.queryByTestId("device-stat-shellTiers")).not.toBeInTheDocument()
    expect(screen.getByTestId("device-stat-placement")).toBeInTheDocument()
  })

  it("badges a lifecycle state that is not active, and stays quiet when it is", () => {
    const { rerender } = render(<DeviceHero row={row()} />)
    expect(screen.queryByText("Revoked")).not.toBeInTheDocument()

    rerender(<DeviceHero row={row({ adminState: "revoked" })} />)
    expect(screen.getByText("Revoked")).toBeInTheDocument()
  })
})
