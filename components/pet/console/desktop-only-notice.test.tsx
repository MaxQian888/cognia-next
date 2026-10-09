import { render, screen } from "@testing-library/react"
import { DesktopOnlyNotice } from "./desktop-only-notice"

describe("DesktopOnlyNotice", () => {
  it("says what the tab is, why it stays on the desktop, and where to find it", () => {
    render(<DesktopOnlyNotice tab="customize" />)
    const notice = screen.getByTestId("pet-desktop-only-notice")
    expect(notice).toHaveAttribute("data-tab", "customize")
    expect(notice).toHaveTextContent(/Customize is on your desktop/)
    expect(notice).toHaveTextContent(/species, colors, skin and size/)
    expect(notice).toHaveTextContent(/stored on your desktop/)
    expect(notice).toHaveTextContent(/Pet → Customize/)
  })

  it.each(["insights", "plugins"] as const)("explains the %s tab too", (tab) => {
    render(<DesktopOnlyNotice tab={tab} />)
    // Two descriptions: what the tab is for, then why it is desktop-only.
    const notice = screen.getByTestId("pet-desktop-only-notice")
    expect(notice.querySelectorAll("[data-slot='empty-description']").length).toBe(2)
  })

  it("still explains a tab with no description of its own", () => {
    render(<DesktopOnlyNotice tab="journal" />)
    const notice = screen.getByTestId("pet-desktop-only-notice")
    expect(notice.querySelectorAll("[data-slot='empty-description']").length).toBe(1)
  })
})
