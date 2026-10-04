import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { BridgeServerPanel } from "./server-panel"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { ExternalBridgeSettings } from "@/types/wiki"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const mockStatus = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockRestart = jest.fn()
const mockHostStatus = jest.fn()
const mockHostConfig = jest.fn()
const mockHostConfigUpdate = jest.fn()
const mockHostClients = jest.fn()
const mockHostClientCreate = jest.fn()
const mockHostClientRevoke = jest.fn()
const mockHostClientRotate = jest.fn()
const mockHostStart = jest.fn()
let mockHostManaged = false
let mockRevealBlocked = false
const mockRevealGate = jest.fn()
jest.mock("@/hooks/use-secret-reveal", () => ({
  useSecretReveal: () => async (action: () => void | Promise<void>) => {
    mockRevealGate()
    if (mockRevealBlocked) return "blocked"
    await action()
    return "revealed"
  },
}))
jest.mock("@/lib/external-bridge/tauri-control", () => ({
  getMcpServerStatus: () => mockStatus(),
  getExternalBridgeStatus: () => mockHostStatus(),
  getExternalBridgeConfig: () => mockHostConfig(),
  updateExternalBridgeConfig: (...a: unknown[]) => mockHostConfigUpdate(...a),
  listExternalBridgeClients: () => mockHostClients(),
  createExternalBridgeClient: (...a: unknown[]) => mockHostClientCreate(...a),
  revokeExternalBridgeClient: (...a: unknown[]) => mockHostClientRevoke(...a),
  rotateExternalBridgeClient: (...a: unknown[]) => mockHostClientRotate(...a),
  startExternalBridge: () => mockHostStart(),
  startMcpServer: (...a: unknown[]) => mockStart(...a),
  restartMcpServer: (...a: unknown[]) => mockRestart(...a),
  stopMcpServer: () => mockStop(),
}))

const mockReleaseClient = jest.fn()
jest.mock("@/lib/external-bridge/workspace/release-client", () => ({
  releaseBridgeClient: (...a: unknown[]) => mockReleaseClient(...a),
}))

// The panel subscribes to the real routing plane and the real remote-host
// store, so "a remote host is active" and "it manages the bridge" are seeded
// through them (see `driveRemoteHost`) rather than through a plain function a
// render reads once. That is what lets a test flip them mid-render and watch
// the panel follow, which a stubbed `isRemoteHostActive` could never show.
let mockRemoteActive = false

jest.mock("@/lib/external-bridge/token", () => ({
  generateToken: jest.fn(() => Promise.resolve("tok_generated")),
}))
jest.mock("@/lib/tauri/admin-lease", () => ({
  issueHostAdminLease: jest.fn(async () => ({ token: "lease-1" })),
}))

let capability = true
jest.mock("@/hooks/use-host-profile", () => ({
  ...jest.requireActual("@/hooks/use-host-profile"),
  useCapability: () => capability,
}))

const mockResolveSidecar = jest.fn()
jest.mock("../bridge-runtime", () => ({
  ...jest.requireActual("../bridge-runtime"),
  resolveSidecarPath: () => mockResolveSidecar(),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const remoteTransport: Transport = {
  call: jest.fn(async () => undefined) as Transport["call"],
  subscribe: jest.fn(() => () => undefined) as unknown as Transport["subscribe"],
}

/** A host build whose manifest does (or does not) carry the bridge lifecycle. */
function remoteHostState(managed: boolean) {
  return {
    activeHostId: "h1",
    hosts: [
      {
        id: "h1",
        label: "cloud",
        config: { baseUrl: "https://host.example", serverVersion: "1.0.0" } as CompanionConfig,
        credentialRef: "remote-host:h1",
        addedAt: 1,
        connectionState: "ready" as const,
        ...(managed
          ? {
              featureManifest: {
                schemaVersion: 1 as const,
                hostBuildId: "1.0.0",
                platform: "headless" as const,
                generatedAt: 1,
                features: {
                  "external-bridge.lifecycle": {
                    version: 1,
                    operations: ["external_bridge_status"],
                  },
                },
                limits: {},
              } as unknown as HostFeatureManifest,
            }
          : {}),
      },
    ],
  }
}

/**
 * Point the panel at a remote host the way the desktop does: install its
 * transport on the routing plane and mark it active in the store.
 */
function driveRemoteHost({ managed }: { managed: boolean }): void {
  setActiveRemoteTransport(remoteTransport)
  useRemoteHostStore.setState(remoteHostState(managed))
}

function setup(over: Partial<ExternalBridgeSettings> = {}) {
  if (mockRemoteActive) driveRemoteHost({ managed: mockHostManaged })
  const onChange = jest.fn()
  const settings = {
    enabled: false,
    enabledScopes: [],
    ...over,
  } as ExternalBridgeSettings
  render(<BridgeServerPanel settings={settings} onChange={onChange} />)
  return { onChange }
}

async function settleInitialStatus(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  __resetRoutingForTests()
  useRemoteHostStore.setState({ activeHostId: null, hosts: [] })
})

beforeEach(() => {
  mockRevealBlocked = false
  mockRevealGate.mockClear()
  capability = true
  mockHostManaged = false
  mockRemoteActive = false
  mockStatus.mockReset().mockResolvedValue({ running: false, port: null, startedAt: null })
  mockHostStatus.mockReset().mockResolvedValue({
    state: "stopped",
    endpoint: null,
    startedAt: null,
  })
  mockHostConfig.mockReset().mockResolvedValue({
    revision: 1,
    enabledScopes: ["wiki:cognia"],
    port: 47890,
    bindMode: "loopback",
    autoStart: false,
  })
  mockHostConfigUpdate.mockReset()
  mockHostClients.mockReset().mockResolvedValue([])
  mockHostClientCreate.mockReset().mockResolvedValue({
    client: { id: "client-1" },
    credential: "cognia_once",
  })
  mockHostClientRevoke.mockReset().mockResolvedValue({
    id: "client-1",
    name: "Cognia controller",
    scopes: [],
    createdAt: 1,
    revokedAt: 2,
  })
  mockHostClientRotate.mockReset().mockResolvedValue({
    client: { id: "client-1" },
    credential: "cognia_rotated",
  })
  mockHostStart.mockReset().mockResolvedValue(47890)
  mockStart.mockReset().mockResolvedValue(3001)
  mockStop.mockReset().mockResolvedValue(undefined)
  mockRestart.mockReset().mockResolvedValue(3001)
  mockResolveSidecar.mockReset().mockResolvedValue("/opt/cognia/sidecar/cognia-mcp.mjs")
})

describe("BridgeServerPanel", () => {
  it("does not copy a stored token when biometric disclosure is blocked", async () => {
    mockRevealBlocked = true
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: jest.fn() },
      configurable: true,
    })
    setup({ bearerToken: "stored-token" })
    await settleInitialStatus()
    fireEvent.click(screen.getByRole("button", { name: "server.copyTokenAria" }))
    await waitFor(() => expect(mockRevealGate).toHaveBeenCalledTimes(1))
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it("uses host-owned config and sidecar resolution for an active remote host", async () => {
    capability = false
    mockHostManaged = true
    mockRemoteActive = true
    const { onChange } = setup({
      enabled: false,
      enabledScopes: ["wiki:cognia"],
      httpPort: 47890,
    })

    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))

    await waitFor(() => expect(mockHostStart).toHaveBeenCalled())
    expect(mockHostClientCreate).toHaveBeenCalledWith(
      {
        name: "server.defaultClientName",
        scopes: ["wiki:cognia"],
      },
      "lease-1"
    )
    expect(mockResolveSidecar).not.toHaveBeenCalled()
    expect(mockStart).not.toHaveBeenCalled()
    for (const [next] of onChange.mock.calls) {
      expect(next).not.toHaveProperty("bearerToken")
    }
  })

  it("follows a host switch without any other re-render", async () => {
    // Local desktop without the MCP runtime: nothing to drive, so "web".
    capability = false
    setup({ enabled: true, enabledScopes: ["wiki:cognia"] })
    expect(await screen.findByText("badgeWeb")).toBeInTheDocument()
    expect(mockHostStatus).not.toHaveBeenCalled()

    // The desktop attaches to a host whose build manages the bridge. No prop
    // changes; only the routing plane and the store move.
    act(() => driveRemoteHost({ managed: true }))
    expect(await screen.findByText("badgeIdle")).toBeInTheDocument()
    await waitFor(() => expect(mockHostStatus).toHaveBeenCalled())

    // Switching to a host that does not advertise the lifecycle drops the
    // panel back to "web" instead of keeping the previous host's answer.
    act(() => useRemoteHostStore.setState(remoteHostState(false)))
    expect(await screen.findByText("badgeWeb")).toBeInTheDocument()

    // Detaching entirely returns the panel to the local answer.
    capability = true
    act(() => driveRemoteHost({ managed: true }))
    expect(await screen.findByText("badgeIdle")).toBeInTheDocument()
    mockStatus.mockClear()
    act(() => {
      setActiveRemoteTransport(null)
      useRemoteHostStore.setState({ activeHostId: null, hosts: [] })
    })
    await waitFor(() => expect(mockStatus).toHaveBeenCalled())
    expect(screen.getByText("badgeIdle")).toBeInTheDocument()
  })

  it("starts the server with the configured port and the real sidecar path", async () => {
    const { onChange } = setup({ enabled: false, bearerToken: "tok_abc", httpPort: 4444 })

    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))

    await waitFor(() => expect(mockStart).toHaveBeenCalled())
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4444,
        token: "tok_abc",
        sidecarPath: "/opt/cognia/sidecar/cognia-mcp.mjs",
      })
    )
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it("defaults the start port to 3001 rather than letting the OS assign one", async () => {
    // An OS-assigned port cannot be written into a client config ahead of time,
    // and producing such a config is this surface's entire job.
    setup({ enabled: false, bearerToken: "tok_abc", httpPort: undefined })

    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))

    await waitFor(() => expect(mockStart).toHaveBeenCalled())
    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ port: 3001 }))
  })

  it("mints a token on first enable", async () => {
    const { onChange } = setup({ enabled: false, bearerToken: undefined })

    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ bearerToken: "tok_generated" })
      )
    )
  })

  it("stops the server when switched off", async () => {
    setup({ enabled: true, bearerToken: "tok_abc" })

    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))

    await waitFor(() => expect(mockStop).toHaveBeenCalled())
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("does not drive the Rust server without the mcp-runtime capability", async () => {
    capability = false
    const { onChange } = setup({ enabled: false, bearerToken: "tok_abc" })

    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("persists an edited HTTP port", async () => {
    const { onChange } = setup({ httpPort: 3001 })
    await settleInitialStatus()

    const input = screen.getByLabelText("server.httpPort")
    fireEvent.change(input, { target: { value: "4444" } })
    fireEvent.blur(input)

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ httpPort: 4444 }))
  })

  it("refuses 0, which cannot be written into a client config ahead of time", async () => {
    setup({ httpPort: 3001 })
    await settleInitialStatus()
    expect(screen.getByLabelText("server.httpPort")).toHaveAttribute("min", "1")
  })

  it("restarts a running listener onto the edited port", async () => {
    // Persisting alone left the listener on the old port while the setup
    // snippet immediately advertised the new one.
    mockStatus.mockResolvedValue({ running: true, port: 3001, startedAt: "now" })
    mockRestart.mockResolvedValue(4444)
    const { onChange } = setup({ enabled: true, bearerToken: "tok_abc", httpPort: 3001 })
    await waitFor(() => expect(mockStatus).toHaveBeenCalled())

    const input = screen.getByLabelText("server.httpPort")
    fireEvent.change(input, { target: { value: "4444" } })
    fireEvent.blur(input)

    await waitFor(() => expect(mockRestart).toHaveBeenCalled())
    expect(mockRestart).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4444, sidecarPath: "/opt/cognia/sidecar/cognia-mcp.mjs" })
    )
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ httpPort: 4444 }))
  })

  it("does not restart a listener that is not running", async () => {
    mockStatus.mockResolvedValue({ running: false, port: null, startedAt: null })
    setup({ enabled: false, bearerToken: "tok_abc", httpPort: 3001 })
    await waitFor(() => expect(mockStatus).toHaveBeenCalled())

    const input = screen.getByLabelText("server.httpPort")
    fireEvent.change(input, { target: { value: "4444" } })
    fireEvent.blur(input)

    await new Promise((r) => setTimeout(r, 20))
    expect(mockRestart).not.toHaveBeenCalled()
  })

  it("says so when the listener stayed on the old port", async () => {
    // The restart can fail; silently leaving the two out of sync is the state
    // this whole surface exists to make visible.
    mockStatus.mockResolvedValue({ running: true, port: 3001, startedAt: "now" })
    setup({ enabled: true, bearerToken: "tok_abc", httpPort: 4444 })

    expect(await screen.findByTestId("bridge-port-diverged")).toHaveTextContent(
      "server.httpPortDiverged:3001"
    )
  })

  it("refuses to start when the sidecar is not installed", async () => {
    // Rust spawns `node <path>`; starting against a path that is not there
    // fails inside the child with nothing useful surfaced.
    mockResolveSidecar.mockResolvedValue(null)
    const { onChange } = setup({ enabled: false, bearerToken: "tok_abc" })

    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    )
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("shows when the token was last rotated", async () => {
    // Persisted on every rotation and previously never displayed, so "did I
    // already rotate this?" had no answer in the UI.
    const rotated = Date.UTC(2026, 6, 28, 8, 15)
    setup({ bearerToken: "tok_abc", tokenRotatedAt: rotated })
    await settleInitialStatus()

    expect(screen.getByTestId("bridge-token-rotated-at")).toHaveTextContent(
      `server.tokenRotatedAt:${new Date(rotated).toLocaleString()}`
    )
  })

  it("omits the rotation line when the token has never been rotated", async () => {
    setup({ bearerToken: "tok_abc", tokenRotatedAt: undefined })
    await settleInitialStatus()
    expect(screen.queryByTestId("bridge-token-rotated-at")).not.toBeInTheDocument()
  })

  it("masks the token until revealed", async () => {
    setup({ bearerToken: "tok_secret_value" })
    await settleInitialStatus()

    expect(screen.queryByText("tok_secret_value")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "server.show" }))
    expect(screen.getByText("tok_secret_value")).toBeInTheDocument()
  })

  it("requires confirmation before rotating", async () => {
    const { onChange } = setup({ bearerToken: "tok_abc" })

    fireEvent.click(screen.getByRole("button", { name: "server.rotateTokenAria" }))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByText("server.rotateConfirmAction"))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ bearerToken: "tok_generated" })
      )
    )
  })

  it("revokes the active host-managed client after confirmation", async () => {
    const { toast } = jest.requireMock("sonner")
    capability = false
    mockHostManaged = true
    mockRemoteActive = true
    mockHostClients.mockResolvedValue([
      { id: "client-old", name: "Retired laptop", scopes: [], createdAt: 1, revokedAt: 2 },
      { id: "client-1", name: "Cognia controller", scopes: [], createdAt: 3 },
    ])
    setup({ enabled: true, enabledScopes: ["wiki:cognia"] })
    await settleInitialStatus()

    fireEvent.click(screen.getByTestId("bridge-revoke-client"))
    expect(mockHostClientRevoke).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByText("server.revokeConfirmAction"))

    // The already-revoked row must be skipped — revoking it again would be a
    // no-op while the live credential kept working.
    await waitFor(() => expect(mockHostClientRevoke).toHaveBeenCalledWith("client-1", "lease-1"))
    // ADR-0203: the revoked client's jobs and root grant are released too.
    await waitFor(() => expect(mockReleaseClient).toHaveBeenCalledWith("client-1"))
    expect(toast.success).toHaveBeenCalledWith("server.toastClientRevoked:Cognia controller")
  })

  it("clears the one-time credential from the screen once revoked", async () => {
    capability = false
    mockHostManaged = true
    mockRemoteActive = true
    mockHostClients
      // Enable mints one because nothing active exists yet; the revoke lookup
      // then finds it.
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "client-1", name: "Ctl", scopes: [], createdAt: 3 }])
    // Port must match the host config, or enabling takes the update-config
    // branch instead of the client-create one.
    setup({ enabled: false, enabledScopes: ["wiki:cognia"], httpPort: 47890 })
    await settleInitialStatus()

    // Enabling mints a credential and shows it.
    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))
    await waitFor(() => expect(mockHostStart).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "server.show" }))
    expect(screen.getByText("cognia_once")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("bridge-revoke-client"))
    fireEvent.click(await screen.findByText("server.revokeConfirmAction"))

    await waitFor(() => expect(screen.queryByText("cognia_once")).not.toBeInTheDocument())
    expect(screen.getByText("server.tokenNone")).toBeInTheDocument()
  })

  it("reports no active client instead of calling revoke", async () => {
    const { toast } = jest.requireMock("sonner")
    capability = false
    mockHostManaged = true
    mockRemoteActive = true
    mockHostClients.mockResolvedValue([
      { id: "client-old", name: "Retired", scopes: [], createdAt: 1, revokedAt: 2 },
    ])
    setup({ enabled: true, enabledScopes: ["wiki:cognia"] })
    await settleInitialStatus()

    fireEvent.click(screen.getByTestId("bridge-revoke-client"))
    fireEvent.click(await screen.findByText("server.revokeConfirmAction"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("server.noActiveClientError"))
    expect(mockHostClientRevoke).not.toHaveBeenCalled()
  })

  it("offers no revoke control on the local MCP path", async () => {
    setup({ enabled: true, bearerToken: "tok_abc" })
    await settleInitialStatus()

    // The local path has one bearer token and no client identity to revoke;
    // rotation already invalidates the old value there.
    expect(screen.queryByTestId("bridge-revoke-client")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "server.rotateTokenAria" })).toBeInTheDocument()
  })

  it("surfaces a failed start rather than leaving the toggle looking successful", async () => {
    const { toast } = jest.requireMock("sonner")
    mockStart.mockRejectedValue(new Error("address already in use"))
    setup({ enabled: false, bearerToken: "tok_abc" })

    fireEvent.click(screen.getByRole("switch", { name: "server.toggleAriaLabel" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("address already in use"))
  })

  it("surfaces a failed rotation", async () => {
    const { toast } = jest.requireMock("sonner")
    const { generateToken } = jest.requireMock("@/lib/external-bridge/token")
    generateToken.mockRejectedValueOnce(new Error("crypto unavailable"))
    setup({ bearerToken: "tok_abc" })

    fireEvent.click(screen.getByRole("button", { name: "server.rotateTokenAria" }))
    fireEvent.click(await screen.findByText("server.rotateConfirmAction"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("crypto unavailable"))
  })

  it("copies the token", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    setup({ bearerToken: "tok_abc" })

    fireEvent.click(screen.getByRole("button", { name: "server.copyTokenAria" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("tok_abc"))
  })

  it("reports the listening port once the HTTP transport is up", async () => {
    mockStatus.mockResolvedValue({ running: true, port: 4444, startedAt: Date.now() })
    setup({ enabled: true, bearerToken: "tok_abc" })

    expect(await screen.findByText("server.statusHttpListening:4444")).toBeInTheDocument()
    expect(await screen.findByText("badgeLive")).toBeInTheDocument()
  })

  it("reports stdio mode when enabled without an HTTP listener", async () => {
    mockStatus.mockResolvedValue({ running: false, port: null, startedAt: null })
    setup({ enabled: true, bearerToken: "tok_abc" })

    expect(await screen.findByText("server.statusStdioActive")).toBeInTheDocument()
    expect(await screen.findByText("badgeIdle")).toBeInTheDocument()
  })

  it("reports off when disabled", async () => {
    setup({ enabled: false })
    expect(await screen.findByText("server.statusOff")).toBeInTheDocument()
  })

  it("shows the web badge without the mcp-runtime capability", async () => {
    capability = false
    setup({ enabled: true })

    expect(await screen.findByText("badgeWeb")).toBeInTheDocument()
  })

  it("keeps rendering when the status probe rejects", async () => {
    // Web mode and desktop init races both land in the swallow branch.
    mockStatus.mockRejectedValue(new Error("not available"))
    setup({ enabled: true })

    expect(await screen.findByText("server.statusStdioActive")).toBeInTheDocument()
  })

  it("stops polling while the document is hidden", async () => {
    setup({ enabled: true })
    await waitFor(() => expect(mockStatus).toHaveBeenCalled())
    const callsWhileVisible = mockStatus.mock.calls.length

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    })
    document.dispatchEvent(new Event("visibilitychange"))

    await new Promise((r) => setTimeout(r, 50))
    expect(mockStatus.mock.calls.length).toBe(callsWhileVisible)

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    })
  })
})
