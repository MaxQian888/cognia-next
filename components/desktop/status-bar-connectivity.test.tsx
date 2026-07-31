/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockNetwork = { status: { connected: true, connectionType: "unknown" } }
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => mockNetwork,
}))

let mockConnection: string | null = null
jest.mock("@/hooks/companion/use-connection-state", () => ({
  useConnectionState: () => mockConnection,
}))

const mockRequestOpenSettings = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: { requestOpenSettings: jest.Mock }) => unknown) =>
    selector({ requestOpenSettings: mockRequestOpenSettings }),
}))

import { StatusBarConnectivity } from "./status-bar-connectivity"

beforeEach(() => {
  mockNetwork.status = { connected: true, connectionType: "unknown" }
  mockConnection = null
  mockRequestOpenSettings.mockClear()
})

describe("StatusBarConnectivity", () => {
  it("shows the online state when the network is connected", () => {
    render(<StatusBarConnectivity />)
    expect(screen.getByTestId("status-connectivity")).toHaveAttribute("aria-label", "connOnline")
  })

  it("shows offline when the network is down", () => {
    mockNetwork.status = { connected: false, connectionType: "none" }
    render(<StatusBarConnectivity />)
    expect(screen.getByTestId("status-connectivity")).toHaveAttribute("aria-label", "connOffline")
  })

  it("reflects the companion reconnecting tier when online", () => {
    mockConnection = "reconnecting"
    render(<StatusBarConnectivity />)
    expect(screen.getByTestId("status-connectivity")).toHaveAttribute(
      "aria-label",
      "connReconnecting"
    )
  })

  it("treats an unauthenticated companion tier as offline", () => {
    mockConnection = "unauthenticated"
    render(<StatusBarConnectivity />)
    expect(screen.getByTestId("status-connectivity")).toHaveAttribute("aria-label", "connOffline")
  })

  it("network-down overrides a connected companion tier", () => {
    mockNetwork.status = { connected: false, connectionType: "none" }
    mockConnection = "connected"
    render(<StatusBarConnectivity />)
    expect(screen.getByTestId("status-connectivity")).toHaveAttribute("aria-label", "connOffline")
  })

  it("opens companion settings on click", () => {
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    expect(mockRequestOpenSettings).toHaveBeenCalledWith("companion")
  })
})
