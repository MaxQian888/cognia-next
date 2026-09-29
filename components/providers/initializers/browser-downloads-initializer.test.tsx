import { render } from "@testing-library/react"

const mockUseFeed = jest.fn()
jest.mock("@/hooks/browser/use-browser-downloads", () => ({
  useBrowserDownloadFeed: (enabled: boolean) => mockUseFeed(enabled),
}))
const mockIsTauri = jest.fn()
jest.mock("@/lib/native/utils", () => ({ isTauri: () => mockIsTauri() }))

import { BrowserDownloadsInitializer } from "./browser-downloads-initializer"

describe("BrowserDownloadsInitializer", () => {
  beforeEach(() => {
    mockUseFeed.mockReset()
    mockIsTauri.mockReset()
  })

  it("keeps the download feed running on the desktop and renders nothing", () => {
    mockIsTauri.mockReturnValue(true)
    const { container } = render(<BrowserDownloadsInitializer />)
    expect(mockUseFeed).toHaveBeenCalledWith(true)
    expect(container).toBeEmptyDOMElement()
  })

  it("leaves the feed off outside Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    render(<BrowserDownloadsInitializer />)
    expect(mockUseFeed).toHaveBeenCalledWith(false)
  })
})
