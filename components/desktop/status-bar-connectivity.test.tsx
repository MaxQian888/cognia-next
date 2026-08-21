/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

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

const mockReconnectWs = jest.fn()
const mockReconnectRtc = jest.fn(() => "no-tier" as const)
let mockTier = "ws-tunnel"
jest.mock("@/lib/tauri", () => ({
  transport: {
    reconnectWs: () => mockReconnectWs(),
    reconnectRtc: () => mockReconnectRtc(),
    onTierChange: (handler: (tier: string) => void) => {
      handler(mockTier)
      return jest.fn()
    },
  },
}))

let mockPlatform = "tauri"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockPlatform,
}))

let mockTarget: null | {
  id: string
  kind: "standalone" | "companion"
  platform: "web"
  hostKind?: "cloud" | "desktop"
} = { id: "host-a", kind: "companion", platform: "web", hostKind: "cloud" }
let mockRuntimeConnection = "online"
let mockVaultState = "unlocked"
let mockHostCompatible = true

jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({
    target: mockTarget,
    vaultState: mockVaultState,
    connectionState: mockRuntimeConnection,
    host:
      mockTarget?.kind === "companion"
        ? { compatible: mockHostCompatible, operations: ["claude_send"], grants: ["claude.chat"] }
        : undefined,
  }),
}))

jest.mock("@/components/account/runtime-target-menu-section", () => ({
  RuntimeTargetMenuSection: () => <div data-testid="runtime-target-menu" />,
}))

const mockGetHost = jest.fn()
jest.mock("@/lib/companion/credential-book", () => ({
  activeAccountNamespace: () => "account-a",
  companionCredentialBook: () => ({ get: mockGetHost }),
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
  mockTarget = { id: "host-a", kind: "companion", platform: "web", hostKind: "cloud" }
  mockRuntimeConnection = "online"
  mockVaultState = "unlocked"
  mockHostCompatible = true
  mockTier = "ws-tunnel"
  mockPush.mockClear()
  mockRequestOpenSettings.mockClear()
  mockReconnectWs.mockClear()
  mockReconnectRtc.mockClear()
  mockGetHost.mockReset().mockResolvedValue(null)
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

  it("opens a local runtime summary before navigating to companion settings", () => {
    mockTarget = null
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    expect(screen.getByText("connectionCenter.title")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.thisDesktop")).toBeInTheDocument()
    expect(screen.getAllByText("connectionCenter.localRuntime")).not.toHaveLength(0)
    expect(mockRequestOpenSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "connectionCenter.actions.settings" }))
    expect(mockRequestOpenSettings).toHaveBeenCalledWith("companion")
  })

  it("shows remote Host, network, and transport details for paired Web", () => {
    mockPlatform = "web"
    mockTarget = { id: "host-a", kind: "companion", platform: "web", hostKind: "cloud" }
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))

    expect(screen.getByText("connectionCenter.cloudHost")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.network")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.hostLink")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.transport")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.tier.ws-tunnel")).toBeInTheDocument()
    expect(screen.getByTestId("runtime-target-menu")).toBeInTheDocument()
  })

  it("shows persisted Host identity and runtime diagnostics without another probe", async () => {
    mockPlatform = "web"
    mockNetwork.status = { connected: true, connectionType: "wifi" }
    mockTarget = { id: "host-a", kind: "companion", platform: "web", hostKind: "cloud" }
    mockGetHost.mockResolvedValue({
      hostId: "host-a",
      accountNamespace: "account-a",
      label: "Build server",
      endpoints: { baseUrl: "https://cognia.example.com" },
      serverVersion: "2.4.1",
      connection: {
        status: "offline",
        generation: 2,
        lastOkAt: 1_700_000_000_000,
        lastErrorAt: 1_700_000_100_000,
        lastError: "Timed out while opening the event stream",
      },
    })

    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))

    expect(await screen.findByText("Build server")).toBeInTheDocument()
    expect(screen.getByText("https://cognia.example.com")).toBeInTheDocument()
    expect(screen.getByText("2.4.1")).toBeInTheDocument()
    expect(screen.getByText("Timed out while opening the event stream")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.networkType.wifi")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.auth.unlocked")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.protocolStatus.compatible")).toBeInTheDocument()
    expect(screen.getByText("connectionCenter.capabilityCount")).toBeInTheDocument()
    await waitFor(() =>
      expect(mockGetHost).toHaveBeenCalledWith({ accountNamespace: "account-a", hostId: "host-a" })
    )
  })

  it("reconnects both WebSocket and WebRTC transports from the popover", () => {
    mockPlatform = "web"
    mockTarget = { id: "host-a", kind: "companion", platform: "web", hostKind: "desktop" }
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    fireEvent.click(screen.getByRole("button", { name: "connectionCenter.actions.reconnect" }))

    expect(mockReconnectWs).toHaveBeenCalledTimes(1)
    expect(mockReconnectRtc).toHaveBeenCalledTimes(1)
  })

  it("routes paired Web failures to the shared recovery screen from the popover", () => {
    mockPlatform = "web"
    mockConnection = "offline"
    mockRuntimeConnection = "offline"
    mockTarget = { id: "host-a", kind: "companion", platform: "web", hostKind: "cloud" }
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    expect(mockPush).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "connectionCenter.actions.recover" }))
    expect(mockPush).toHaveBeenCalledWith("/pair?mode=recover&state=offline")
    expect(mockRequestOpenSettings).not.toHaveBeenCalled()
  })

  it("presents standalone Web as a local runtime with an explicit connect action", () => {
    mockPlatform = "web"
    mockTarget = { id: "web-standalone", kind: "standalone", platform: "web" }
    render(<StatusBarConnectivity />)

    expect(screen.getByTestId("status-connectivity")).toHaveAttribute(
      "aria-label",
      "connectionCenter.localRuntime"
    )
    fireEvent.click(screen.getByTestId("status-connectivity"))
    expect(screen.getByText("connectionCenter.thisBrowser")).toBeInTheDocument()
    expect(screen.queryByText("connectionCenter.hostLink")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "connectionCenter.actions.connectHost" }))
    expect(mockPush).toHaveBeenCalledWith("/pair?mode=add")
  })

  it("does not dress a standalone browser up as a connected runtime", () => {
    // Standalone is a *mode*, not a connection: every host-backed operation
    // resolves to `requires-companion`. A success-green badge and no other
    // qualification is what read as "already paired" while the rest of the app
    // was still asking the user to pair.
    mockPlatform = "web"
    mockTarget = { id: "web-standalone", kind: "standalone", platform: "web" }
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))

    expect(screen.getByTestId("connection-status-badge").className).not.toMatch(/bg-success/)
    expect(screen.getByTestId("standalone-scope-note")).toHaveTextContent(
      "connectionCenter.standaloneScope"
    )
  })

  it("keeps the success badge for a native host, which really is the runtime", () => {
    mockPlatform = "tauri"
    mockTarget = null
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))

    expect(screen.getByTestId("connection-status-badge").className).toMatch(/bg-success/)
    expect(screen.queryByTestId("standalone-scope-note")).not.toBeInTheDocument()
  })

  it("offers the already-paired Hosts from the local runtime, not only a fresh pairing", () => {
    // The footer's only action here is "Connect Host" → `/pair?mode=add`. Without
    // the switcher, a browser that had already paired was told to pair again.
    mockPlatform = "web"
    mockTarget = { id: "web-standalone", kind: "standalone", platform: "web" }
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    expect(screen.getByTestId("runtime-target-menu")).toBeInTheDocument()
  })
})
