/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

// next-intl is globally mocked in jest.setup.ts to resolve real
// i18n/messages/en.json keys, so we assert against canonical English
// strings (no NextIntlClientProvider wrapper required).

type TierHandler = (tier: string) => void
const tierHandlers: Set<TierHandler> = new Set()
type ReconnectResult = "ok" | "no-tier" | "throttled"

const transportMock: {
  isCapacitor: jest.Mock<boolean, []>
  tier: string
  getActiveTier: jest.Mock<string, []>
  onTierChange: jest.Mock<() => void, [TierHandler]>
  reconnectRtc: jest.Mock<ReconnectResult, []>
} = {
  isCapacitor: jest.fn(() => false),
  tier: "offline",
  getActiveTier: jest.fn(() => transportMock.tier),
  onTierChange: jest.fn((h: TierHandler) => {
    h(transportMock.tier)
    tierHandlers.add(h)
    return () => {
      tierHandlers.delete(h)
    }
  }),
  reconnectRtc: jest.fn<ReconnectResult, []>(() => "ok"),
}

jest.mock("@/lib/tauri", () => ({
  isCapacitor: () => transportMock.isCapacitor(),
  isTauri: () => false,
  get transport() {
    return transportMock
  },
}))

const toastMock = {
  success: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}
jest.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastMock.success(msg),
    warning: (msg: string) => toastMock.warning(msg),
    error: (msg: string) => toastMock.error(msg),
  },
}))

import { TransportTierIndicator } from "./transport-tier-indicator"

beforeEach(() => {
  transportMock.isCapacitor.mockReset()
  transportMock.isCapacitor.mockReturnValue(false)
  transportMock.tier = "offline"
  transportMock.getActiveTier.mockClear()
  transportMock.onTierChange.mockClear()
  transportMock.reconnectRtc.mockReset()
  transportMock.reconnectRtc.mockReturnValue("ok")
  tierHandlers.clear()
  toastMock.success.mockReset()
  toastMock.warning.mockReset()
  toastMock.error.mockReset()
})

describe("<TransportTierIndicator />", () => {
  it("renders nothing outside Capacitor", () => {
    render(<TransportTierIndicator />)
    expect(screen.queryByTestId("mobile-transport-tier")).not.toBeInTheDocument()
  })

  it("renders the seeded tier inside Capacitor", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    render(<TransportTierIndicator />)
    expect(screen.getByTestId("mobile-transport-tier")).toHaveTextContent(/WebRTC \(direct\)/)
    expect(transportMock.getActiveTier).toHaveBeenCalled()
    expect(transportMock.onTierChange).toHaveBeenCalled()
  })

  it("updates the tier when transport emits a change", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "offline"
    render(<TransportTierIndicator />)
    expect(screen.getByTestId("mobile-transport-tier")).toHaveTextContent(/Offline/)
    act(() => {
      for (const h of tierHandlers) h("ws-lan")
    })
    expect(screen.getByTestId("mobile-transport-tier")).toHaveTextContent(/LAN/)
  })

  it("detaches the subscription on unmount", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "ws-tunnel"
    const { unmount } = render(<TransportTierIndicator />)
    expect(tierHandlers.size).toBe(1)
    unmount()
    expect(tierHandlers.size).toBe(0)
  })

  it("renders the reconnect button only on an RTC tier", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-relay"
    const { unmount } = render(<TransportTierIndicator />)
    expect(screen.getByTestId("mobile-transport-tier-reconnect")).toBeInTheDocument()
    unmount()

    transportMock.tier = "ws-lan"
    render(<TransportTierIndicator />)
    expect(screen.queryByTestId("mobile-transport-tier-reconnect")).not.toBeInTheDocument()
  })

  it("calls reconnectRtc and surfaces 'ok' as success toast", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    transportMock.reconnectRtc.mockReturnValue("ok")
    render(<TransportTierIndicator />)
    fireEvent.click(screen.getByTestId("mobile-transport-tier-reconnect"))
    expect(transportMock.reconnectRtc).toHaveBeenCalledTimes(1)
    expect(toastMock.success).toHaveBeenCalled()
  })

  it("surfaces 'throttled' as a warning toast", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    transportMock.reconnectRtc.mockReturnValue("throttled")
    render(<TransportTierIndicator />)
    fireEvent.click(screen.getByTestId("mobile-transport-tier-reconnect"))
    expect(toastMock.warning).toHaveBeenCalled()
  })

  it("surfaces 'no-tier' as a warning toast", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    transportMock.reconnectRtc.mockReturnValue("no-tier")
    render(<TransportTierIndicator />)
    fireEvent.click(screen.getByTestId("mobile-transport-tier-reconnect"))
    expect(toastMock.warning).toHaveBeenCalled()
  })

  it("renders an error toast when reconnectRtc throws", () => {
    transportMock.isCapacitor.mockReturnValue(true)
    transportMock.tier = "rtc-direct"
    transportMock.reconnectRtc.mockImplementation(() => {
      throw new Error("boom")
    })
    render(<TransportTierIndicator />)
    fireEvent.click(screen.getByTestId("mobile-transport-tier-reconnect"))
    expect(toastMock.error).toHaveBeenCalled()
  })
})
