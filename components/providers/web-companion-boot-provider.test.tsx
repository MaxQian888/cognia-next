import { act, render, waitFor } from "@testing-library/react"

const replaceMock = jest.fn()
let pathnameValue = "/"
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => pathnameValue,
}))

let platformValue = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

const hydrateMock = jest.fn()
jest.mock("@/lib/tauri/transport-companion", () => ({
  hydrateCompanionConfig: (...args: unknown[]) => hydrateMock(...args),
}))

const transportCallMock = jest.fn()
const connectionStateListeners = new Set<(state: string) => void>()
let connectionStateValue = "connected"
const planeHealthListeners = new Set<(health: { rpc: string; events: string }) => void>()
let planeHealthValue = { rpc: "ready", events: "ready" }
const connectionUnsubscribeMock = jest.fn()
const planeUnsubscribeMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: {
    call: (...args: unknown[]) => transportCallMock(...args),
    getConnectionState: () => connectionStateValue,
    onConnectionStateChange: (listener: (state: string) => void) => {
      connectionStateListeners.add(listener)
      return () => {
        connectionUnsubscribeMock()
        connectionStateListeners.delete(listener)
      }
    },
    getPlaneHealth: () => planeHealthValue,
    onPlaneHealthChange: (listener: (health: { rpc: string; events: string }) => void) => {
      planeHealthListeners.add(listener)
      listener(planeHealthValue)
      return () => {
        planeUnsubscribeMock()
        planeHealthListeners.delete(listener)
      }
    },
  },
}))

jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: () => ({ accountId: "acct-web" }),
}))

const runSyncDownMock = jest.fn()
const foregroundTeardown = jest.fn()
const eventTeardown = jest.fn()
const installEventDrivenSyncMock = jest.fn(() => eventTeardown)
const networkTeardown = jest.fn()
const installNetworkSyncMock = jest.fn(async () => networkTeardown)
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (...args: unknown[]) => runSyncDownMock(...args),
  installForegroundSync: () => foregroundTeardown,
  installEventDrivenSync: () => installEventDrivenSyncMock(),
  installNetworkSync: () => installNetworkSyncMock(),
}))

const hostStateStopMock = jest.fn()
const hostStateResyncMock = jest.fn().mockResolvedValue(undefined)
const installHostStateSyncMock = jest.fn().mockResolvedValue({
  status: { migrationStage: "host-authoritative" },
  stop: hostStateStopMock,
  resync: hostStateResyncMock,
})
jest.mock("@/lib/sync/host-state-service", () => ({
  hostStateStatusAllowsWrites: () => true,
  installHostStateSyncForTarget: (...args: unknown[]) => installHostStateSyncMock(...args),
}))

import { WebCompanionBootProvider } from "./web-companion-boot-provider"
import {
  __resetRuntimeSnapshotForTesting,
  getRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { stopRuntimeTargetSubscriptions } from "@/lib/runtime/runtime-target-lifecycle"
import { remoteEventResyncCoordinator } from "@/lib/tauri/resync-coordinator"
import { restartWebHostBindings } from "@/lib/companion/web-host-binding-lifecycle"
import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"

const ENV_KEY = "NEXT_PUBLIC_COGNIA_SERVER_URL"

beforeEach(() => {
  platformValue = "web"
  pathnameValue = "/"
  process.env[ENV_KEY] = "https://cloud.example.com:7890"
  hydrateMock.mockResolvedValue(null)
  runSyncDownMock.mockResolvedValue(undefined)
  connectionStateValue = "connected"
  connectionStateListeners.clear()
  planeHealthValue = { rpc: "ready", events: "ready" }
  planeHealthListeners.clear()
  transportCallMock.mockResolvedValue({
    schemaVersion: 2,
    hostBuildId: "host-build",
    platform: "headless",
    generatedAt: 1,
    hostIdentity: { id: "host-1", kind: "cloud" },
    protocol: { min: 1, max: 2 },
    transportCapabilities: { eventStreamReady: 1 },
    features: {
      "claude.host-tools": {
        version: 1,
        operations: ["claude_send"],
      },
    },
    operations: [
      {
        name: "claude_send",
        feature: "claude.host-tools",
        featureVersion: 1,
        healthy: true,
      },
    ],
    deviceGrants: ["agent.run"],
    limits: {
      rpcJsonBodyBytes: 1,
      skillMaxResources: 1,
      skillMaxResourceBytes: 1,
      skillUploadChunkBytes: 1,
      mcpRequestBodyBytes: 1,
      maxConcurrentProxyCalls: 1,
    },
  })
  installHostStateSyncMock.mockClear()
  hostStateStopMock.mockClear()
  hostStateResyncMock.mockClear()
})

afterEach(() => {
  delete process.env[ENV_KEY]
  window.localStorage.clear()
  __resetRuntimeSnapshotForTesting()
  jest.clearAllMocks()
})

describe("WebCompanionBootProvider", () => {
  it("redirects an unpaired browser with a configured server to /pair", async () => {
    render(
      <WebCompanionBootProvider>
        <div>child</div>
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/pair"))
    expect(runSyncDownMock).not.toHaveBeenCalled()
  })

  it("does not redirect away from onboarding routes", async () => {
    pathnameValue = "/pair"
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(hydrateMock).toHaveBeenCalled())
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("paired: runs sync-down and installs the sync listeners", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
      targetId: "companion-cloud",
    })
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalled())
    await waitFor(() => expect(installNetworkSyncMock).toHaveBeenCalled())
    await waitFor(() =>
      expect(getRuntimeSnapshot()).toMatchObject({
        target: {
          id: "companion-cloud",
          kind: "companion",
          hostKind: "cloud",
        },
        connectionState: "online",
        host: {
          compatible: true,
          operations: ["claude_send"],
          grants: ["agent.run"],
        },
      })
    )
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("installs and resyncs HostState when the Web Host advertises state sync", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
      accountId: "acct-web",
      targetId: "companion-cloud",
    })
    transportCallMock.mockResolvedValue(
      buildLocalHostFeatureManifest({ platform: "headless", hostId: "host-cloud" })
    )

    const view = render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )

    await waitFor(() =>
      expect(installHostStateSyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "acct-web", runtimeTargetId: "companion-cloud" })
      )
    )
    view.unmount()
    expect(hostStateStopMock).toHaveBeenCalledTimes(1)
  })

  it("keeps Web connecting until the event replay boundary is ready", async () => {
    planeHealthValue = { rpc: "ready", events: "replaying" }
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })

    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(installEventDrivenSyncMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("connecting"))
    expect(runSyncDownMock).not.toHaveBeenCalled()

    planeHealthValue = { rpc: "ready", events: "ready" }
    for (const listener of planeHealthListeners) listener(planeHealthValue)

    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("online"))
  })

  it("fails incompatible when the host cannot prove replay completion", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    transportCallMock.mockResolvedValueOnce({
      schemaVersion: 2,
      hostBuildId: "legacy",
      platform: "headless",
      generatedAt: 1,
      hostIdentity: { id: "host-legacy", kind: "cloud" },
      protocol: { min: 1, max: 2 },
      features: {},
      operations: [],
      deviceGrants: [],
      limits: {
        rpcJsonBodyBytes: 1,
        skillMaxResources: 1,
        skillMaxResourceBytes: 1,
        skillUploadChunkBytes: 1,
        mcpRequestBodyBytes: 1,
        maxConcurrentProxyCalls: 1,
      },
    })

    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )

    await waitFor(() =>
      expect(getRuntimeSnapshot()).toMatchObject({
        connectionState: "offline",
        host: { compatible: false },
      })
    )
    expect(runSyncDownMock).not.toHaveBeenCalled()
  })

  it("retries a temporarily unavailable manifest before installing subscriptions", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    const manifest = transportCallMock.getMockImplementation()!
    transportCallMock
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockImplementation(manifest)

    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )

    await waitFor(() => expect(transportCallMock).toHaveBeenCalledTimes(2), { timeout: 1_000 })
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("online"))
    expect(installEventDrivenSyncMock).toHaveBeenCalledTimes(1)
  })

  it("coalesces a failed authoritative sync into one delayed recovery", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    runSyncDownMock
      .mockRejectedValueOnce(new Error("sync unavailable"))
      .mockResolvedValue(undefined)

    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )

    await waitFor(() => expect(runSyncDownMock).toHaveBeenCalledTimes(2), { timeout: 1_000 })
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("online"))
    expect(transportCallMock).toHaveBeenCalledTimes(2)
    expect(installNetworkSyncMock).toHaveBeenCalledTimes(1)
  })

  it("paired: tears down browser network sync on unmount", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    const view = render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(installNetworkSyncMock).toHaveBeenCalled())

    view.unmount()

    expect(networkTeardown).toHaveBeenCalledTimes(1)
    expect(connectionUnsubscribeMock).toHaveBeenCalledTimes(1)
    expect(planeUnsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it("awaits teardown and rebinding after a canonical Web Host switch", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
      targetId: "companion-cloud",
    })
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(installEventDrivenSyncMock).toHaveBeenCalledTimes(1))

    let restarting!: Promise<void>
    act(() => {
      restarting = restartWebHostBindings()
    })
    await restarting

    expect(eventTeardown).toHaveBeenCalledTimes(1)
    expect(installEventDrivenSyncMock).toHaveBeenCalledTimes(2)
  })

  it("stops old sync subscriptions before an external runtime-target switch", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(installNetworkSyncMock).toHaveBeenCalled())

    await stopRuntimeTargetSubscriptions()

    expect(networkTeardown).toHaveBeenCalledTimes(1)
    expect(eventTeardown).toHaveBeenCalledTimes(1)
    expect(foregroundTeardown).toHaveBeenCalledTimes(1)
    expect(connectionUnsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it("no-op off web platforms and without a companion target", async () => {
    platformValue = "tauri"
    const { unmount } = render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    unmount()

    platformValue = "web"
    delete process.env[ENV_KEY]
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await act(async () => {
      window.dispatchEvent(new Event("cognia:companion-config-changed"))
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(hydrateMock).not.toHaveBeenCalled()
    expect(getRuntimeSnapshot()).toMatchObject({
      target: { kind: "standalone" },
      connectionState: "online",
    })
  })

  it("updates availability when the Companion transport reconnects", async () => {
    connectionStateValue = "reconnecting"
    planeHealthValue = { rpc: "ready", events: "connecting" }
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("connecting"))

    connectionStateValue = "connected"
    for (const listener of connectionStateListeners) listener("connected")
    planeHealthValue = { rpc: "ready", events: "ready" }
    for (const listener of planeHealthListeners) listener(planeHealthValue)

    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("online"))
    expect(transportCallMock).toHaveBeenCalledWith("host_feature_manifest", {})
  })

  it("returns to connecting for either plane and resyncs before becoming online again", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("online"))
    expect(runSyncDownMock).toHaveBeenCalledTimes(1)

    planeHealthValue = { rpc: "ready", events: "replaying" }
    for (const listener of planeHealthListeners) listener(planeHealthValue)
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("connecting"))
    await remoteEventResyncCoordinator.resolve(["claude"])
    expect(runSyncDownMock).toHaveBeenCalledTimes(2)

    planeHealthValue = { rpc: "ready", events: "ready" }
    for (const listener of planeHealthListeners) listener(planeHealthValue)
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("online"))
    expect(runSyncDownMock).toHaveBeenCalledTimes(3)

    planeHealthValue = { rpc: "unavailable", events: "ready" }
    for (const listener of planeHealthListeners) listener(planeHealthValue)
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("connecting"))
    planeHealthValue = { rpc: "ready", events: "ready" }
    for (const listener of planeHealthListeners) listener(planeHealthValue)

    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("online"))
    expect(transportCallMock).toHaveBeenCalledTimes(3)
    expect(runSyncDownMock).toHaveBeenCalledTimes(4)
  })
})
