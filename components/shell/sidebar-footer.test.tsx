/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({ point }: { point: string }) => <div data-testid={`slot-${point}`} />,
}))
// The account card has its own suite (`sidebar-user-card.test.tsx`), so here it
// is a stub and this file keeps testing what the footer itself decides.
jest.mock("./sidebar-user-card", () => ({
  SidebarUserCard: () => <div data-testid="sidebar-user-card" />,
}))

import { SidebarFooter } from "./sidebar-footer"

describe("SidebarFooter", () => {
  it("ends the rail on the account card, over the rail's bottom plugin slot", () => {
    render(<SidebarFooter />)
    const footer = screen.getByTestId("sidebar-footer")
    expect(footer).toContainElement(screen.getByTestId("slot-sidebar.left.bottom"))
    expect(footer).toContainElement(screen.getByTestId("sidebar-user-card"))
  })

  it("no longer carries a Settings row of its own", () => {
    // Settings moved into the account card's menu. The icon column keeps its
    // own gear, so the destination did not become unreachable.
    render(<SidebarFooter />)
    expect(screen.queryByTestId("sidebar-footer-settings")).toBeNull()
  })

  it("takes a caller's class so the rail can place it", () => {
    render(<SidebarFooter className="mt-2" />)
    expect(screen.getByTestId("sidebar-footer")).toHaveClass("mt-2")
  })
})
