/**
 * @jest-environment jsdom
 *
 * ConnectionsSection renders the web-mode banner when the connector controls
 * cannot be driven from this host. The gate is the host profile, not the
 * shell — a companion and a standalone browser are both "not Tauri" and need
 * opposite explanations.
 */

import { render, screen } from "@testing-library/react"

const mockUseSearchParams = jest.fn(() => new URLSearchParams())

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => mockUseSearchParams(),
  usePathname: () => "/settings",
}))

let hostProfile = "web-standalone"
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => hostProfile }))

// Stub the tab sub-components to avoid deep dep chains
jest.mock("./tabs/overview-tab", () => ({ OverviewTab: () => <div>Overview</div> }))
jest.mock("./tabs/adapters-tab", () => ({ AdaptersTab: () => <div>Adapters</div> }))
jest.mock("./tabs/outbound-tab", () => ({ OutboundTab: () => <div>Outbound</div> }))
jest.mock("./tabs/audit-tab", () => ({ AuditTab: () => <div>Audit</div> }))
jest.mock("./tabs/conversations-tab", () => ({
  ConversationsTab: () => <div>Conversations</div>,
}))
jest.mock("./tabs/inbox-assets-tab", () => ({ InboxAssetsTab: () => <div>Assets</div> }))

import { ConnectionsSection } from "./connections-section"

beforeEach(() => {
  hostProfile = "web-standalone"
  mockUseSearchParams.mockReturnValue(new URLSearchParams())
})

describe("ConnectionsSection", () => {
  it("tells a standalone browser there is no runtime to configure", () => {
    render(<ConnectionsSection />)
    expect(screen.getByRole("status", { name: /web mode banner/i })).toBeInTheDocument()
    expect(screen.getByTestId("connector-host-notice")).toHaveAttribute("data-cause", "no-runtime")
  })

  /**
   * The banner used to claim "Adapters require the desktop app — already
   * configured conversations sync read-only here." Both halves were false for
   * a companion: its adapters run on the paired host, and the Inbox writes
   * back through the relay rather than being read-only.
   */
  it("tells a companion its bots run on the paired host, not that it needs a desktop", () => {
    hostProfile = "cloud-companion"
    render(<ConnectionsSection />)
    expect(screen.getByTestId("connector-host-notice")).toHaveAttribute(
      "data-cause",
      "runs-on-host"
    )
  })

  it("shows no banner on the desktop", () => {
    hostProfile = "desktop"
    render(<ConnectionsSection />)
    expect(screen.queryByRole("status", { name: /web mode banner/i })).not.toBeInTheDocument()
  })

  // Tunnel folded into Overview and the standalone Inbox summary was dropped in
  // favour of the /inbox route; both used to have their own tab here. The
  // count plus the two name assertions are what stop either from creeping back.
  it("renders the seven operational tabs without duplicate Inbox or Tunnel tabs", () => {
    render(<ConnectionsSection />)
    expect(screen.getAllByRole("tab")).toHaveLength(7)
    expect(screen.queryByRole("tab", { name: /^Tunnel$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: /^Inbox$/i })).not.toBeInTheDocument()
  })

  it("maps the legacy tunnel deep link to Overview", () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams("connectionsTab=tunnel"))
    render(<ConnectionsSection />)
    expect(screen.getByRole("tab", { name: /^Overview$/i })).toHaveAttribute("data-state", "active")
  })

  it("makes the tab list horizontally scrollable on narrow viewports", () => {
    const { container } = render(<ConnectionsSection />)
    const list = container.querySelector('[role="tablist"]')
    expect(list?.className).toContain("overflow-x-auto")
  })
})
