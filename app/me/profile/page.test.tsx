/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

// The route composes the shared `<ProfileSection />` (settings store +
// credential hook + avatar pipeline). Stub it so the route's own shell
// chrome is the unit under test.
jest.mock("@/components/settings/profile/profile-section", () => ({
  ProfileSection: () => <div data-testid="stub-profile-section">section</div>,
}))

import MobileProfilePage from "./page"

describe("MobileProfilePage", () => {
  it("renders the SubPageShell + embeds the shared section", () => {
    render(<MobileProfilePage />)
    expect(screen.getByTestId("mobile-profile-page")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-sub-page-back")).toBeInTheDocument()
    expect(screen.getByTestId("stub-profile-section")).toBeInTheDocument()
  })

  it("links the back button to /me", () => {
    render(<MobileProfilePage />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/me")
  })

  it("renders the localized section heading", () => {
    render(<MobileProfilePage />)
    // next-intl resolves real en.json keys in the global jest mock, so the
    // heading reflects `mobile.me.profileRow`.
    expect(screen.getByRole("heading", { level: 1, name: /profile/i })).toBeInTheDocument()
  })
})
