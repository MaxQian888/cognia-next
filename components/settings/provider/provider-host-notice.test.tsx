/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { ProviderHostNotice } from "./provider-host-notice"

let mockProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => mockProfile,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const COMPANION_KEY = "settings.providerHostNotice.companion.dismiss"
const MOBILE_LOCAL_KEY = "settings.providerHostNotice.mobile-local.dismiss"

describe("ProviderHostNotice", () => {
  afterEach(() => {
    mockProfile = "desktop"
    window.localStorage.clear()
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

  it("hides the companion notice on dismiss and persists it across remounts", () => {
    mockProfile = "cloud-companion"
    const { unmount } = render(<ProviderHostNotice kind="companion" />)
    fireEvent.click(screen.getByRole("button", { name: "hostNotice.dismiss" }))
    expect(screen.queryByTestId("provider-host-notice-companion")).not.toBeInTheDocument()
    expect(window.localStorage.getItem(COMPANION_KEY)).toContain('"hash":"companion"')

    unmount()
    const { container } = render(<ProviderHostNotice kind="companion" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("hides the mobile-local notice on dismiss and persists it", () => {
    mockProfile = "mobile-companion"
    render(<ProviderHostNotice kind="mobile-local" />)
    fireEvent.click(screen.getByRole("button", { name: "hostNotice.dismiss" }))
    expect(screen.queryByTestId("provider-host-notice-mobile-local")).not.toBeInTheDocument()
    expect(window.localStorage.getItem(MOBILE_LOCAL_KEY)).toContain('"hash":"mobile-local"')
  })

  it("keeps the two kinds' dismissals independent", () => {
    mockProfile = "mobile-companion"
    window.localStorage.setItem(
      COMPANION_KEY,
      JSON.stringify({ hash: "companion", at: Date.now() })
    )
    const { container } = render(<ProviderHostNotice kind="companion" />)
    expect(container).toBeEmptyDOMElement()
    render(<ProviderHostNotice kind="mobile-local" />)
    expect(screen.getByTestId("provider-host-notice-mobile-local")).toBeInTheDocument()
  })

  it("ignores a malformed persisted dismissal", () => {
    mockProfile = "cloud-companion"
    window.localStorage.setItem(COMPANION_KEY, "not json")
    render(<ProviderHostNotice kind="companion" />)
    expect(screen.getByTestId("provider-host-notice-companion")).toBeInTheDocument()
  })
})
