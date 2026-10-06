/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

import { ProviderHostNotice } from "./provider-host-notice"
import enProviders from "@/i18n/messages/en/providers.json"
import zhProviders from "@/i18n/messages/zh-CN/providers.json"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

let mockProfile = "desktop"
let mockProviders = enProviders
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => mockProfile,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    key === "hostNotice.companionBody" ? mockProviders.hostNotice.companionBody : key,
}))

const COMPANION_KEY = "settings.providerHostNotice.companion.dismiss"
const MOBILE_LOCAL_KEY = "settings.providerHostNotice.mobile-local.dismiss"

describe("ProviderHostNotice", () => {
  afterEach(() => {
    mockProfile = "desktop"
    mockProviders = enProviders
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

  it.each([
    {
      locale: "en",
      providers: enProviders,
      generated: enMessages.providers,
      body: "Keys and endpoints entered here are stored only on this device and are not synced to the paired host. Each chat request run on the paired host sends this device's key and endpoint to the host for that request; they are not saved in the host's provider settings.",
    },
    {
      locale: "zh-CN",
      providers: zhProviders,
      generated: zhMessages.providers,
      body: "此处填写的密钥与端点仅保存在当前设备，不会同步到已配对的主机。每次由配对主机执行的聊天请求都会将本设备的密钥与端点发送给主机，仅供该次请求使用，不会保存到主机的提供商设置中。",
    },
  ])(
    "explains local storage and per-request forwarding in $locale",
    ({ providers, generated, body }) => {
      mockProviders = providers
      expect(generated.hostNotice.companionBody).toBe(body)
      for (const profile of ["cloud-companion", "mobile-companion"]) {
        mockProfile = profile
        const { unmount } = render(<ProviderHostNotice kind="companion" />)
        expect(screen.getByText(body)).toBeVisible()
        unmount()
      }
    }
  )

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
