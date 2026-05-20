/**
 * @jest-environment jsdom
 *
 * Tests for the platform dispatch on /discover. Phase 2 removed the
 * desktop redirect: the page now renders `DiscoverDesktopBody` on web /
 * Tauri and `DiscoverMobileBody` on Capacitor mobile.
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let platformValue: "tauri" | "mobile" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

jest.mock("@/components/discover/discover-desktop-body", () => ({
  DiscoverDesktopBody: () => <div data-testid="stub-desktop-body" />,
}))
jest.mock("@/components/mobile/discover/discover-mobile-body", () => ({
  DiscoverMobileBody: () => <div data-testid="stub-mobile-body" />,
}))

import DiscoverPage from "./page"

beforeEach(() => {
  platformValue = "web"
})

describe("DiscoverPage platform dispatch", () => {
  it("renders the desktop body on web", () => {
    platformValue = "web"
    render(<DiscoverPage />)
    expect(screen.getByTestId("stub-desktop-body")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-mobile-body")).not.toBeInTheDocument()
  })

  it("renders the desktop body on Tauri", () => {
    platformValue = "tauri"
    render(<DiscoverPage />)
    expect(screen.getByTestId("stub-desktop-body")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-mobile-body")).not.toBeInTheDocument()
  })

  it("renders the mobile body on Capacitor mobile", () => {
    platformValue = "mobile"
    render(<DiscoverPage />)
    expect(screen.getByTestId("stub-mobile-body")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-desktop-body")).not.toBeInTheDocument()
  })
})
