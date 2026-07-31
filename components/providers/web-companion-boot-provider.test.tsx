import { render, waitFor } from "@testing-library/react"

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
const connectionUnsubscribeMock = jest.fn()
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
  },
}))

jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: () => ({ accountId: "acct-web" }),
}))

const runSyncDownMock = jest.fn()
const foregroundTeardown = jest.fn()
const eventTeardown = jest.fn()
const networkTeardown = jest.fn()
const installNetworkSyncMock = jest.fn(async () => networkTeardown)
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (...args: unknown[]) => runSyncDownMock(...args),
  installForegroundSync: () => foregroundTeardown,
  installEventDrivenSync: () => eventTeardown,
  installNetworkSync: () => installNetworkSyncMock(),
}))

import { WebCompanionBootProvider } from "./web-companion-boot-provider"
import {
  __resetRuntimeSnapshotForTesting,
  getRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"
import { stopRuntimeTargetSubscriptions } from "@/lib/runtime/runtime-target-lifecycle"

const ENV_KEY = "NEXT_PUBLIC_COGNIA_SERVER_URL"

beforeEach(() => {
  platformValue = "web"
  pathnameValue = "/"
  process.env[ENV_KEY] = "https://cloud.example.com:7890"
  hydrateMock.mockResolvedValue(null)
  runSyncDownMock.mockResolvedValue(undefined)
  connectionStateValue = "connected"
  connectionStateListeners.clear()
  transportCallMock.mockResolvedValue({
    schemaVersion: 2,
    hostBuildId: "host-build",
    platform: "headless",
    generatedAt: 1,
    hostIdentity: { id: "host-1", kind: "cloud" },
    protocol: { min: 1, max: 2 },
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
      deviceJwt: "jwt",
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

  it("paired: tears down browser network sync on unmount", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      deviceJwt: "jwt",
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
  })

  it("stops old sync subscriptions before an external runtime-target switch", async () => {
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      deviceJwt: "jwt",
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
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(hydrateMock).not.toHaveBeenCalled()
    expect(getRuntimeSnapshot()).toMatchObject({
      target: { kind: "standalone" },
      connectionState: "online",
    })
  })

  it("updates availability when the Companion transport reconnects", async () => {
    connectionStateValue = "reconnecting"
    hydrateMock.mockResolvedValue({
      baseUrl: "https://cloud.example.com:7890",
      deviceJwt: "jwt",
      deviceId: "dev-1",
      serverVersion: "1.0.0",
    })
    render(
      <WebCompanionBootProvider>
        <div />
      </WebCompanionBootProvider>
    )
    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("connecting"))

    for (const listener of connectionStateListeners) listener("connected")

    await waitFor(() => expect(getRuntimeSnapshot().connectionState).toBe("online"))
    expect(transportCallMock).toHaveBeenCalledWith("host_feature_manifest", {})
  })
})
