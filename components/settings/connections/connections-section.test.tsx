/**
 * @jest-environment jsdom
 *
 * ConnectionsSection renders the web-mode banner when not running on Tauri.
 * After M4.1 (#45) the gate is `usePlatform() === "tauri"` so the test
 * mocks the hook directly.
 */

import { render, screen } from "@testing-library/react"

const mockUseSearchParams = jest.fn(() => new URLSearchParams())

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => mockUseSearchParams(),
  usePathname: () => "/settings",
}))

jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

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
import { usePlatform } from "@/hooks/use-platform"

beforeEach(() => {
  ;(usePlatform as jest.Mock).mockReturnValue("web")
  mockUseSearchParams.mockReturnValue(new URLSearchParams())
})

describe("ConnectionsSection", () => {
  it("shows the web-mode banner when not on tauri", () => {
    render(<ConnectionsSection />)
    expect(screen.getByRole("status", { name: /web mode banner/i })).toBeInTheDocument()
    expect(screen.getByText(/Adapters require the desktop app/i)).toBeInTheDocument()
    expect(screen.getByText(/Already-configured conversations sync read-only/i)).toBeInTheDocument()
  })

  it("does not show the web-mode banner on tauri", () => {
    ;(usePlatform as jest.Mock).mockReturnValue("tauri")
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
