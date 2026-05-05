/**
 * @jest-environment jsdom
 *
 * Task 111 — ConnectionsSection renders web-mode banner when isTauri()=false.
 */

import { render, screen } from "@testing-library/react"

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))

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
import { isTauri } from "@/lib/tauri"

beforeEach(() => {
  ;(isTauri as jest.Mock).mockReturnValue(false)
})

describe("ConnectionsSection", () => {
  it("shows the web-mode banner when isTauri()=false", () => {
    render(<ConnectionsSection />)
    expect(screen.getByRole("status", { name: /web mode banner/i })).toBeInTheDocument()
    expect(screen.getByText(/Adapters require the desktop app/i)).toBeInTheDocument()
    expect(screen.getByText(/Already-configured conversations sync read-only/i)).toBeInTheDocument()
  })

  it("does not show the web-mode banner when isTauri()=true", () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    render(<ConnectionsSection />)
    expect(screen.queryByRole("status", { name: /web mode banner/i })).not.toBeInTheDocument()
  })
})
