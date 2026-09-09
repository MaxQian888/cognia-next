/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { BrowserStreamingNotice } from "./browser-streaming-notice"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let standalone = true
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => standalone,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { mobileRuntimeMode: "standalone" } }),
}))

beforeEach(() => {
  standalone = true
})

describe("BrowserStreamingNotice", () => {
  // A paired phone runs every turn through the desktop sidecar, so the
  // browser's CORS rules have nothing to do with it. The old mobile page gave
  // this advice unconditionally and was simply wrong on a paired device.
  it("renders nothing when chat does not run in this webview", () => {
    standalone = false
    const { container } = render(<BrowserStreamingNotice providerId="openai" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("confirms direct streaming for a provider whose endpoint allows it", () => {
    render(<BrowserStreamingNotice providerId="openai" />)
    const notice = screen.getByTestId("browser-streaming-notice")
    expect(notice).toHaveAttribute("data-tone", "info")
    expect(notice).toHaveTextContent("supportedTitle")
  })

  it("accepts every provider on the shared list", () => {
    for (const id of ["anthropic", "openai", "google"]) {
      const { unmount } = render(<BrowserStreamingNotice providerId={id} />)
      expect(screen.getByTestId("browser-streaming-notice")).toHaveTextContent("supportedTitle")
      unmount()
    }
  })

  it("warns for a provider that is not on the list", () => {
    render(<BrowserStreamingNotice providerId="deepseek" />)
    const notice = screen.getByTestId("browser-streaming-notice")
    expect(notice).toHaveAttribute("data-tone", "warn")
    expect(notice).toHaveTextContent("unsupportedTitle")
  })

  // The list is about the provider's OFFICIAL origin. Once the user points it
  // somewhere else, that origin's CORS policy is its own and nothing here can
  // know it, so the notice says so rather than repeating the built-in answer.
  it("stops claiming direct streaming once a custom endpoint is set", () => {
    render(<BrowserStreamingNotice providerId="openai" baseURL="https://gw.example/v1" />)
    const notice = screen.getByTestId("browser-streaming-notice")
    expect(notice).toHaveAttribute("data-tone", "warn")
    expect(notice).toHaveTextContent("gatewayTitle")
    expect(notice).not.toHaveTextContent("supportedTitle")
  })

  it("treats a blank endpoint as no endpoint", () => {
    render(<BrowserStreamingNotice providerId="openai" baseURL="   " />)
    expect(screen.getByTestId("browser-streaming-notice")).toHaveTextContent("supportedTitle")
  })

  it("reports a custom endpoint on an unsupported provider as the gateway case", () => {
    render(<BrowserStreamingNotice providerId="deepseek" baseURL="https://gw.example/v1" />)
    expect(screen.getByTestId("browser-streaming-notice")).toHaveTextContent("gatewayTitle")
  })
})
