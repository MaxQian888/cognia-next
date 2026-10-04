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

let mockRunActive = false
jest.mock("@/lib/devices/execution-host-guard", () => ({
  anyRunActive: () => Promise.resolve(mockRunActive),
}))

import { act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { REMOTE_HOSTS_SETTINGS_HREF, StatusBarConnectivity } from "./status-bar-connectivity"

const initialHostStore = useRemoteHostStore.getState()
const mockDeactivate = jest.fn()
function drivenHost(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "box",
    label: "Build box",
    credentialRef: "ref",
    addedAt: 1,
    connectionState: "ready",
    config: { baseUrl: "https://box.example:27890", serverVersion: "2.1.0" },
    ...overrides,
  } as RemoteHost
}
function driveHost(host: RemoteHost | null) {
  useRemoteHostStore.setState(
    {
      ...initialHostStore,
      hosts: host ? [host] : [],
      activeHostId: host?.id ?? null,
      deactivate: mockDeactivate,
    },
    true
  )
}
afterAll(() => useRemoteHostStore.setState(initialHostStore, true))

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
  mockRunActive = false
  mockDeactivate.mockClear()
  driveHost(null)
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
    expect(mockRequestOpenSettings).toHaveBeenCalledWith("connectivity")
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

/**
 * A Tauri desktop's runtime target stays `null` while the remote-host store
 * drives another machine, so a segment that read remoteness from the target
 * said "Local runtime / This desktop" beside the switcher naming the remote.
 */
describe("a desktop driving a remote host", () => {
  beforeEach(() => {
    mockPlatform = "tauri"
    mockTarget = null
  })

  it("names the driven host on the trigger instead of the local runtime", () => {
    driveHost(drivenHost({ connectionState: "degraded" }))
    render(<StatusBarConnectivity />)
    const trigger = screen.getByTestId("status-connectivity")
    expect(trigger).toHaveAttribute("data-driven-host", "box")
    expect(trigger).toHaveAttribute("data-tone", "warning")
    expect(trigger).toHaveAttribute("aria-label", "connectionCenter.drivenAria")
    expect(trigger).toHaveTextContent("Build box")
  })

  it("describes the host in the popover, error included", () => {
    driveHost(drivenHost({ connectionError: "certificate fingerprint changed" }))
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    expect(screen.getByTestId("connection-status-badge")).toHaveTextContent("ready")
    expect(screen.getByText("https://box.example:27890")).toBeInTheDocument()
    expect(screen.getByText("2.1.0")).toBeInTheDocument()
    expect(screen.queryByText("connectionCenter.thisDesktop")).not.toBeInTheDocument()
    expect(screen.queryByText("connectionCenter.localRuntime")).not.toBeInTheDocument()
    // No manifest published yet: "checking", never a count of zero.
    expect(screen.getByText("connectionCenter.protocolStatus.checking")).toBeInTheDocument()
    expect(screen.getByTestId("driven-host-error")).toHaveTextContent(
      "certificate fingerprint changed"
    )
  })

  it("returns to local through the in-flight guard", async () => {
    driveHost(drivenHost())
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    await userEvent.click(screen.getByTestId("driven-host-return-local"))
    expect(mockDeactivate).toHaveBeenCalledTimes(1)
  })

  it("asks before returning to local while a turn is in flight", async () => {
    mockRunActive = true
    driveHost(drivenHost())
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    await userEvent.click(screen.getByTestId("driven-host-return-local"))
    expect(mockDeactivate).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByTestId("execution-host-confirm"))
    expect(mockDeactivate).toHaveBeenCalledTimes(1)
  })

  it("opens the Remote hosts panel to manage hosts", () => {
    driveHost(drivenHost())
    render(<StatusBarConnectivity />)
    fireEvent.click(screen.getByTestId("status-connectivity"))
    fireEvent.click(screen.getByTestId("driven-host-manage"))
    expect(mockPush).toHaveBeenCalledWith(REMOTE_HOSTS_SETTINGS_HREF)
    expect(REMOTE_HOSTS_SETTINGS_HREF).toContain("section=connectivity")
    expect(REMOTE_HOSTS_SETTINGS_HREF).toContain("connectivityPanel=remote-hosts")
  })

  it("goes back to the local summary the moment the host is deactivated", () => {
    driveHost(drivenHost())
    render(<StatusBarConnectivity />)
    expect(screen.getByTestId("status-connectivity")).toHaveAttribute("data-driven-host", "box")
    act(() => driveHost(null))
    expect(screen.getByTestId("status-connectivity")).not.toHaveAttribute("data-driven-host")
    expect(screen.getByTestId("status-connectivity")).toHaveAttribute(
      "aria-label",
      "connectionCenter.localRuntime"
    )
  })

  /** Only a desktop drives through this store; a browser keeps its own target. */
  it("ignores the store on a shell that is not the desktop", () => {
    mockPlatform = "web"
    mockTarget = { id: "host-a", kind: "companion", platform: "web", hostKind: "cloud" }
    driveHost(drivenHost())
    render(<StatusBarConnectivity />)
    expect(screen.getByTestId("status-connectivity")).not.toHaveAttribute("data-driven-host")
  })
})
