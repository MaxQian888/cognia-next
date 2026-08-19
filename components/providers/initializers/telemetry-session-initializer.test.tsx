import { render } from "@testing-library/react"

const mockPathname = jest.fn(() => "/memory")

jest.mock("@/lib/telemetry/app-session", () => ({
  trackAppLaunched: jest.fn(async () => true),
  trackScreenViewed: jest.fn(async () => true),
}))
jest.mock("next-intl", () => ({ useLocale: () => "zh-CN" }))
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname() }))
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => true }))

import { trackAppLaunched, trackScreenViewed } from "@/lib/telemetry/app-session"
import { TelemetrySessionInitializer } from "./telemetry-session-initializer"

const launched = trackAppLaunched as jest.Mock
const viewed = trackScreenViewed as jest.Mock

beforeEach(() => {
  launched.mockClear()
  viewed.mockClear()
  mockPathname.mockReturnValue("/memory")
})

describe("TelemetrySessionInitializer", () => {
  it("reports the launch with the resolved runtime and locale", () => {
    render(<TelemetrySessionInitializer />)
    expect(launched).toHaveBeenCalledTimes(1)
    expect(launched.mock.calls[0][0]).toMatchObject({ runtime: "tauri", locale: "zh-CN" })
  })

  it("renders nothing", () => {
    const { container } = render(<TelemetrySessionInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("reports the launch once per session, not once per mount", () => {
    const { rerender } = render(<TelemetrySessionInitializer />)
    rerender(<TelemetrySessionInitializer />)
    expect(launched).toHaveBeenCalledTimes(1)
  })

  it("reports a screen view for each route the shell lands on", () => {
    const { rerender } = render(<TelemetrySessionInitializer />)
    expect(viewed).toHaveBeenCalledWith("/memory")
    mockPathname.mockReturnValue("/settings")
    rerender(<TelemetrySessionInitializer />)
    expect(viewed).toHaveBeenLastCalledWith("/settings")
    expect(viewed).toHaveBeenCalledTimes(2)
  })
})
