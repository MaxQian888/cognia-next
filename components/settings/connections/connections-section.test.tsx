/**
 * @jest-environment jsdom
 *
 * ConnectionsSection renders the web-mode banner when not running on Tauri.
 * After M4.1 (#45) the gate is `usePlatform() === "tauri"` so the test
 * mocks the hook directly.
 */

import { render, screen } from "@testing-library/react"

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
jest.mock("./tabs/inbox-tab", () => ({ InboxTab: () => <div>Inbox</div> }))

import { ConnectionsSection } from "./connections-section"
import { usePlatform } from "@/hooks/use-platform"

beforeEach(() => {
  ;(usePlatform as jest.Mock).mockReturnValue("web")
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

  it("renders all nine tab triggers", () => {
    render(<ConnectionsSection />)
    expect(screen.getAllByRole("tab")).toHaveLength(9)
  })

  it("makes the tab list horizontally scrollable on narrow viewports", () => {
    const { container } = render(<ConnectionsSection />)
    const list = container.querySelector('[role="tablist"]')
    expect(list?.className).toContain("overflow-x-auto")
  })
})
