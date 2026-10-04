import { fireEvent, render, screen } from "@testing-library/react"

import { OverviewPanel } from "./overview-panel"

const profile = jest.fn(() => "desktop")
let target: { kind: string; id: string } | null = null
let connection: string | null = null
let hosts: Array<Record<string, unknown>> = []
const tierHandlers: Array<(t: string) => void> = []
const healthHandlers: Array<(h: unknown) => void> = []
let health: { rpc: string; events: string } = { rpc: "ready", events: "ready" }

jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => profile() }))
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ target, vaultState: "ready", connectionState: "connected" }),
}))
jest.mock("@/hooks/companion/use-connection-state", () => ({
  useConnectionState: () => connection,
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (s: unknown) => unknown) =>
    selector({ hosts, activeHostId: "h1" }),
}))
// The active remote host's own transport, which is what a driving desktop's
// link rows have to read: the shared `transport` there is the local proxy.
let remoteTransport: Record<string, unknown> | null = null
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => remoteTransport,
  subscribeActiveRemoteTransport: () => () => undefined,
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [{ deviceId: "d1" }, { deviceId: "d2" }],
}))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: async () => [] }))
jest.mock("@/lib/companion/device-presence-registry", () => ({
  eventPlaneState: (id: string) => (id === "d1" ? "ready" : "disconnected"),
}))
jest.mock("@/lib/tauri", () => ({
  transport: {
    getActiveTier: () => "relay",
    onTierChange: (h: (t: string) => void) => {
      tierHandlers.push(h)
      return () => undefined
    },
    getPlaneHealth: () => health,
    onPlaneHealthChange: (h: (x: unknown) => void) => {
      healthHandlers.push(h)
      return () => undefined
    },
  },
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values?.count !== undefined ? `${key}:${String(values.count)}` : key,
}))

describe("OverviewPanel", () => {
  it("describes a Host shell: local link, no tier, its devices' event planes", () => {
    profile.mockReturnValue("desktop")
    target = null
    render(<OverviewPanel onNavigate={() => undefined} />)
    expect(screen.getByTestId("overview-host-mode")).toHaveTextContent("hostModeValue.host")
    expect(screen.getByTestId("overview-link")).toHaveTextContent("linkValue.local")
    expect(screen.getByTestId("overview-tier")).toHaveTextContent("tierNotApplicable")
    expect(screen.getByTestId("overview-device-planes")).toHaveTextContent("devicePlanes:2")
    expect(screen.getByTestId("overview-device-planes")).toHaveTextContent("plane.ready")
    expect(screen.getByTestId("overview-active-host")).toHaveTextContent("activeHostSelf")
  })

  it("describes a companion: relay tier, the active host, and a degraded plane when only RPC answers", () => {
    profile.mockReturnValue("cloud-companion")
    target = { kind: "companion", id: "h1" }
    connection = "connected"
    hosts = [{ id: "h1", label: "my server", config: { baseUrl: "https://srv:27890" } }]
    health = { rpc: "ready", events: "idle" }
    render(<OverviewPanel onNavigate={() => undefined} />)
    expect(screen.getByTestId("overview-tier")).toHaveTextContent("relay")
    expect(screen.getByTestId("overview-active-host")).toHaveTextContent("my server")
    expect(screen.getByTestId("overview-own-plane")).toHaveTextContent("plane.degraded")
    expect(screen.queryByTestId("overview-device-planes")).toBeNull()
  })

  /**
   * A desktop driving a remote host keeps `target === null` (it is still a
   * Host), which is how the overview came to say "Is a Host / Local / not
   * applicable" right next to "Active host: <remote>".
   */
  it("describes the driven host on a desktop that is driving one", () => {
    profile.mockReturnValue("desktop")
    target = null
    connection = null
    hosts = [
      {
        id: "h1",
        label: "build box",
        connectionState: "degraded",
        connectionError: "capability probe failed",
        config: { baseUrl: "https://box:27890" },
      },
    ]
    health = { rpc: "ready", events: "ready" }
    remoteTransport = {
      getActiveTier: () => "ws-lan",
      onTierChange: () => () => undefined,
      getPlaneHealth: () => health,
      onPlaneHealthChange: () => () => undefined,
    }
    try {
      render(<OverviewPanel onNavigate={() => undefined} />)
      expect(screen.getByTestId("overview-host-mode")).toHaveTextContent("hostModeValue.driving")
      expect(screen.getByTestId("overview-link")).not.toHaveTextContent("linkValue.local")
      expect(screen.getByTestId("overview-link")).toHaveTextContent("degraded")
      expect(screen.getByTestId("overview-tier")).toHaveTextContent("wsLan")
      expect(screen.getByTestId("overview-active-host")).toHaveTextContent("build box")
      expect(screen.getByTestId("overview-active-host-error")).toHaveTextContent(
        "capability probe failed"
      )
      expect(screen.getByTestId("overview-own-plane")).toHaveTextContent("plane.ready")
      // Still a Host for its own phones while it drives another.
      expect(screen.getByTestId("overview-device-planes")).toBeInTheDocument()
    } finally {
      remoteTransport = null
    }
  })

  it("says the driven link is still negotiating before its transport reports a tier", () => {
    profile.mockReturnValue("desktop")
    target = null
    hosts = [
      {
        id: "h1",
        label: "build box",
        connectionState: "connecting",
        config: { baseUrl: "https://box:27890" },
      },
    ]
    remoteTransport = null
    render(<OverviewPanel onNavigate={() => undefined} />)
    expect(screen.getByTestId("overview-tier")).toHaveTextContent("tierPending")
    expect(screen.getByTestId("overview-tier")).not.toHaveTextContent("tierNotApplicable")
  })

  it("offers a shortcut to the Remote hosts panel", () => {
    profile.mockReturnValue("desktop")
    target = null
    hosts = []
    const onNavigate = jest.fn()
    render(<OverviewPanel onNavigate={onNavigate} />)
    fireEvent.click(screen.getByTestId("overview-go-remote-hosts"))
    expect(onNavigate).toHaveBeenCalledWith("remote-hosts")
  })
})
