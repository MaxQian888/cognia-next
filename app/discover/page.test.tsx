/**
 * @jest-environment jsdom
 *
 * Tests for the layout dispatch on /discover. Phase 2 removed the desktop
 * redirect: the page now renders `DiscoverDesktopBody` when there is room and
 * `DiscoverMobileBody` when there is not. The predicate is `useCompactLayout`
 * (viewport width, or a native mobile shell at any width), NOT the runtime
 * platform, so a 375px browser gets the compact body too.
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let compactValue = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => compactValue,
}))

jest.mock("@/components/discover/discover-desktop-body", () => ({
  DiscoverDesktopBody: () => <div data-testid="stub-desktop-body" />,
}))
jest.mock("@/components/mobile/discover/discover-mobile-body", () => ({
  DiscoverMobileBody: () => <div data-testid="stub-mobile-body" />,
}))

import DiscoverPage from "./page"

beforeEach(() => {
  compactValue = false
})

describe("DiscoverPage layout dispatch", () => {
  it("renders the desktop body on a wide viewport", () => {
    compactValue = false
    render(<DiscoverPage />)
    expect(screen.getByTestId("stub-desktop-body")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-mobile-body")).not.toBeInTheDocument()
  })

  it("still renders the desktop body on a second wide render", () => {
    compactValue = false
    render(<DiscoverPage />)
    expect(screen.getByTestId("stub-desktop-body")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-mobile-body")).not.toBeInTheDocument()
  })

  it("renders the compact body on a narrow viewport", () => {
    compactValue = true
    render(<DiscoverPage />)
    expect(screen.getByTestId("stub-mobile-body")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-desktop-body")).not.toBeInTheDocument()
  })
})
