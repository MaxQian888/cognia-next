/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

import MobileNetworkPage from "./page"
import { useCompanionConfig } from "@/hooks/companion/use-companion-config"
import { getStatus, subscribe } from "@/lib/capacitor/network"

jest.mock("@/hooks/companion/use-companion-config")
jest.mock("@/lib/capacitor/network", () => ({
  getStatus: jest.fn(),
  subscribe: jest.fn(),
}))

const mockPaired = (paired: boolean) =>
  (useCompanionConfig as jest.Mock).mockReturnValue({
    config: null,
    paired,
    shortDeviceId: null,
    loading: false,
    reload: jest.fn(),
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockPaired(true)
  ;(getStatus as jest.Mock).mockResolvedValue({
    kind: "ok",
    status: { connected: true, connectionType: "wifi" },
  })
  ;(subscribe as jest.Mock).mockResolvedValue(() => {})
})

describe("MobileNetworkPage", () => {
  it("shows the paired placeholder when unpaired", () => {
    mockPaired(false)
    render(<MobileNetworkPage />)
    expect(screen.getByTestId("paired-only-placeholder")).toBeInTheDocument()
    expect(screen.queryByTestId("me-section-network-connectivity")).toBeNull()
  })

  it("renders the live connectivity read-out when paired", async () => {
    render(<MobileNetworkPage />)
    expect(screen.getByTestId("me-section-network-connectivity")).toBeInTheDocument()
    expect(screen.getByTestId("network-status")).toBeInTheDocument()
    // After the async status resolves, the Wi-Fi connection type is shown.
    await waitFor(() => expect(screen.getByText("Wi-Fi")).toBeInTheDocument())
    expect(screen.getByText("Online")).toBeInTheDocument()
  })

  it("surfaces the manage-on-desktop guidance and no proxy editor", async () => {
    render(<MobileNetworkPage />)
    // Flush the async connectivity read so the state update settles in act().
    await waitFor(() => expect(screen.getByText("Wi-Fi")).toBeInTheDocument())
    expect(screen.getByTestId("network-manage-note")).toBeInTheDocument()
    expect(screen.getByTestId("me-section-network-proxy")).toBeInTheDocument()
    // No proxy tabs / form rendered on mobile.
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("button", { name: /apply|test|save/i })).toBeNull()
  })

  it("shows the direct-connection read-out when paired", async () => {
    // Which signaling server this device will actually dial, and whether its
    // STUN/TURN came from the host or the built-in defaults, was previously
    // impossible to see — and quietly wrong, because a self-hosted signaling
    // server or TURN relay configured on the desktop never reached the phone.
    render(<MobileNetworkPage />)
    await waitFor(() => expect(screen.getByText("Wi-Fi")).toBeInTheDocument())
    expect(screen.getByTestId("rendezvous-signaling")).toBeInTheDocument()
    expect(screen.getByTestId("rendezvous-stun")).toBeInTheDocument()
    expect(screen.getByTestId("rendezvous-turn")).toBeInTheDocument()
  })

  it("hides the direct-connection read-out when unpaired", () => {
    // It describes a connection to a host, so with no host it would be
    // reporting on nothing.
    mockPaired(false)
    render(<MobileNetworkPage />)
    expect(screen.queryByTestId("rendezvous-signaling")).toBeNull()
  })
})
