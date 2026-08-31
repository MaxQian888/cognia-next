/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("next/navigation", () => ({
  useRouter: () => ({ back: jest.fn(), replace: jest.fn(), push: jest.fn() }),
}))

// The route is a mount point, nothing more. Its body has its own suite
// (`components/mobile/plugins/plugins-mobile-body.test.tsx`), and asserting
// list/toggle behaviour again here is how the old page ended up pinning a
// second, weaker plugin surface in place.
jest.mock("@/components/mobile/plugins/plugins-mobile-body", () => ({
  PluginsMobileBody: ({ showHeader }: { showHeader?: boolean }) => (
    <div data-testid="stub-plugins-mobile-body" data-show-header={String(showHeader)} />
  ),
}))

import MobilePluginsPage from "./page"

describe("MobilePluginsPage", () => {
  it("renders the same plugin body /plugins uses on a phone", () => {
    render(<MobilePluginsPage />)
    expect(screen.getByTestId("mobile-plugins-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-plugins-mobile-body")).toBeInTheDocument()
  })

  // Reusing a page body under a shell that is also a page is how you get two
  // stacked headers and no way back to /me.
  it("keeps the Me sub-page chrome and asks the body to drop its own header", () => {
    render(<MobilePluginsPage />)
    expect(screen.getByTestId("mobile-sub-page-back")).toBeInTheDocument()
    expect(screen.getByTestId("stub-plugins-mobile-body")).toHaveAttribute(
      "data-show-header",
      "false"
    )
  })
})
