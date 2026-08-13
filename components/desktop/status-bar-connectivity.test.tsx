/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

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

let mockPlatform = "tauri"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockPlatform,
}))

jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({
    target: { id: "host-a", kind: "companion", platform: "web", hostKind: "cloud" },
    vaultState: "unlocked",
    connectionState: mockConnection === "offline" ? "offline" : "online",
    host: { compatible: true, operations: ["claude_send"], grants: ["claude.chat"] },
  }),
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
  mockPlatform = "tauri"
  mockPush.mockClear()
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

  it("routes paired Web failures to the shared recovery screen", () => {
    mockPlatform = "web"
    mockConnection = "offline"
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    expect(mockPush).toHaveBeenCalledWith("/pair?mode=recover&state=offline")
    expect(mockRequestOpenSettings).not.toHaveBeenCalled()
  })
})
