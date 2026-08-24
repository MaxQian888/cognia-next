import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"

import { DeviceDetail } from "./device-detail"

jest.mock("./tabs/overview-tab", () => ({
  OverviewTab: () => <div data-testid="tab-body-overview" />,
}))
jest.mock("./tabs/capabilities-tab", () => ({
  CapabilitiesTab: () => <div data-testid="tab-body-capabilities" />,
}))
jest.mock("./tabs/access-tab", () => ({ AccessTab: () => <div data-testid="tab-body-access" /> }))
jest.mock("./tabs/runtime-tab", () => ({
  RuntimeTab: () => <div data-testid="tab-body-runtime" />,
}))
jest.mock("./tabs/activity-tab", () => ({
  ActivityTab: () => <div data-testid="tab-body-activity" />,
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
    render(
      <DeviceDetail row={null} activeTab="overview" onTabChange={jest.fn()} actions={actions} />
    )
    expect(screen.getByTestId("device-detail-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("device-detail")).not.toBeInTheDocument()
  })

  it("heads the pane with the device's identity and reachability", () => {
    render(
      <DeviceDetail row={row()} activeTab="overview" onTabChange={jest.fn()} actions={actions} />
    )
    expect(screen.getByRole("heading", { name: "Max's iPhone" })).toBeInTheDocument()
    expect(screen.getByText("Paired device")).toBeInTheDocument()
    expect(screen.getByText("Online")).toBeInTheDocument()
  })

  it("shows the lifecycle badge in the header when it is not active", () => {
    render(
      <DeviceDetail
        row={row({ adminState: "revoked" })}
        activeTab="overview"
        onTabChange={jest.fn()}
        actions={actions}
      />
    )
    expect(screen.getByText("Revoked")).toBeInTheDocument()
  })

  it("offers all five tabs", () => {
    render(
      <DeviceDetail row={row()} activeTab="overview" onTabChange={jest.fn()} actions={actions} />
    )
    for (const tab of ["overview", "capabilities", "access", "runtime", "activity"]) {
      expect(screen.getByTestId(`device-tab-${tab}`)).toBeInTheDocument()
    }
  })

  it("renders the body for the active tab", () => {
    const { rerender } = render(
      <DeviceDetail row={row()} activeTab="overview" onTabChange={jest.fn()} actions={actions} />
    )
    expect(screen.getByTestId("tab-body-overview")).toBeInTheDocument()

    rerender(
      <DeviceDetail row={row()} activeTab="runtime" onTabChange={jest.fn()} actions={actions} />
    )
    expect(screen.getByTestId("tab-body-runtime")).toBeInTheDocument()
  })

  it("reports a tab change rather than owning the state", async () => {
    const onTabChange = jest.fn()
    render(
      <DeviceDetail row={row()} activeTab="overview" onTabChange={onTabChange} actions={actions} />
    )
    await userEvent.click(screen.getByTestId("device-tab-access"))
    expect(onTabChange).toHaveBeenCalledWith("access")
  })

  /**
   * The anti-jump rule from `mcp-panel.tsx`: each body owns its own scroll
   * container and is `min-h-0 flex-1`, so switching tabs never resizes the pane.
   */
  it("gives every tab body its own scroll container", () => {
    const { container } = render(
      <DeviceDetail row={row()} activeTab="overview" onTabChange={jest.fn()} actions={actions} />
    )
    const panel = container.querySelector('[role="tabpanel"]')
    expect(panel?.className).toContain("overflow-y-auto")
    expect(panel?.className).toContain("min-h-0")
  })
})
