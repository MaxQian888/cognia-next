/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { ProviderHostNotice } from "./provider-host-notice"

let mockProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => mockProfile,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("ProviderHostNotice", () => {
  afterEach(() => {
    mockProfile = "desktop"
  })

  it("renders nothing on the desktop / web-standalone hosts", () => {
    for (const profile of ["desktop", "web-standalone", "headless"]) {
      mockProfile = profile
      const { container, unmount } = render(<ProviderHostNotice kind="companion" />)
      expect(container).toBeEmptyDOMElement()
      unmount()
      const local = render(<ProviderHostNotice kind="mobile-local" />)
      expect(local.container).toBeEmptyDOMElement()
      local.unmount()
    }
  })

  it("explains device-local keys on companion profiles", () => {
    for (const profile of ["cloud-companion", "mobile-companion"]) {
      mockProfile = profile
      const { unmount } = render(<ProviderHostNotice kind="companion" />)
      expect(screen.getByTestId("provider-host-notice-companion")).toHaveTextContent(
        "hostNotice.companionBody"
      )
      unmount()
    }
  })

  it("explains that localhost is the phone only on the mobile shell", () => {
    mockProfile = "cloud-companion"
    const { container, unmount } = render(<ProviderHostNotice kind="mobile-local" />)
    expect(container).toBeEmptyDOMElement()
    unmount()
    mockProfile = "mobile-companion"
    render(<ProviderHostNotice kind="mobile-local" />)
    expect(screen.getByTestId("provider-host-notice-mobile-local")).toBeInTheDocument()
  })
})
