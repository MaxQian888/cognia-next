/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// Every segment is covered by its own suite; stub them so this one only asserts
// the id → component mapping and the ordering.
jest.mock("@/components/desktop/status-bar-connectivity", () => ({
  StatusBarConnectivity: () => <div data-testid="seg-connectivity" />,
}))
jest.mock("@/components/desktop/status-bar-sync", () => ({
  StatusBarSync: () => <div data-testid="seg-sync" />,
}))
jest.mock("@/components/desktop/status-bar-terminal", () => ({
  StatusBarTerminal: () => <div data-testid="seg-terminal" />,
}))
jest.mock("@/components/desktop/status-bar-perf", () => ({
  StatusBarPerf: () => <div data-testid="seg-perf" />,
}))
jest.mock("@/components/desktop/status-bar-usage", () => ({
  StatusBarUsage: () => <div data-testid="seg-usage" />,
}))
jest.mock("@/components/desktop/status-bar-run-state", () => ({
  StatusBarRunState: () => <div data-testid="seg-runStatus" />,
}))
jest.mock("@/components/desktop/job-center-panel", () => ({
  JobCenterPanel: () => <div data-testid="seg-jobs" />,
}))
jest.mock("@/components/source-control/status-bar-branch", () => ({
  StatusBarBranch: () => <div data-testid="seg-branch" />,
}))
jest.mock("@/components/notifications/notification-bell", () => ({
  NotificationBell: () => <div data-testid="seg-notifications" />,
}))
jest.mock("@/components/attention/attention-panel", () => ({
  AttentionPanel: () => <div data-testid="seg-attention" />,
}))
jest.mock("@/components/account/account-bar-button", () => ({
  AccountBarButton: () => <div data-testid="seg-accountStatus" />,
}))
jest.mock("@/components/agent/agent-thread-browser", () => ({
  AgentThreadBrowser: () => <div data-testid="seg-agentThreads" />,
}))

import { StatusBarZone } from "./status-bar-zone"
import { getBarCatalog } from "@/lib/shell/bar-items"
import { STATUS_BAR_ITEMS } from "@/types/shell/bars"

const catalog = getBarCatalog("status", "tauri")
const pick = (...ids: string[]) => ids.map((id) => catalog.find((c) => c.id === id)!)

describe("StatusBarZone", () => {
  it("mounts a component for every catalog id", () => {
    render(<StatusBarZone items={catalog} />)
    for (const meta of STATUS_BAR_ITEMS) {
      expect(screen.getByTestId(`seg-${meta.id}`)).toBeInTheDocument()
    }
  })

  it("renders in the order it is given, not catalog order", () => {
    const { container } = render(<StatusBarZone items={pick("runStatus", "connectivity")} />)
    const ids = Array.from(container.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    )
    expect(ids).toEqual(["seg-runStatus", "seg-connectivity"])
  })

  it("unmounts a segment that is absent rather than hiding it", () => {
    // Matters for `perf`: mounting it starts native CPU/memory sampling.
    render(<StatusBarZone items={pick("connectivity")} />)
    expect(screen.queryByTestId("seg-perf")).toBeNull()
  })

  it("renders nothing for an empty zone", () => {
    const { container } = render(<StatusBarZone items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("skips an id with no component instead of throwing", () => {
    // Unreachable for real catalog ids (the first test pins that), but a stored
    // layout is user data and could name an id a later version removed.
    const ghost = { ...catalog[0], id: "ghost" }
    const { container } = render(<StatusBarZone items={[ghost]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
