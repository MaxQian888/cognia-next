import { render, waitFor } from "@testing-library/react"

import type { OutboundDispatcher } from "@/lib/queue/outbound-queue"
import { CompanionOutboundRunnerProvider } from "./companion-outbound-runner-provider"

const unsubscribe = jest.fn()
let pendingObserver: { next?: (count: number) => void } | undefined
jest.mock("dexie", () => ({
  liveQuery: () => ({
    subscribe: (observer: { next?: (count: number) => void }) => {
      pendingObserver = observer
      return { unsubscribe }
    },
  }),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    mobileOutboundQueue: {
      where: () => ({
        equals: () => ({
          filter: () => ({ count: jest.fn().mockResolvedValue(0) }),
        }),
      }),
    },
  }),
}))

jest.mock("@/lib/accounts/active-account-id", () => ({
  DEFAULT_LOCAL_ACCOUNT_ID: "local_acct_a",
}))

const runner = {
  kick: jest.fn().mockResolvedValue(undefined),
  quiesce: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  isDraining: jest.fn().mockReturnValue(false),
}
const createRunner = jest.fn((_options: unknown) => runner)
jest.mock("@/lib/queue/outbound-queue", () => ({
  createOutboundRunner: (options: unknown) => createRunner(options),
}))

jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => false,
}))

jest.mock("@/lib/platform/host-feature-manifest", () => ({
  parseHostFeatureManifest: (value: unknown) => value,
}))

const transportCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => transportCall(...args), subscribe: jest.fn() },
}))

const stopHostStateSync = jest.fn()
const resyncHostState = jest.fn().mockResolvedValue(undefined)
const installHostStateSync = jest.fn().mockResolvedValue({
  stop: stopHostStateSync,
  resync: resyncHostState,
  status: {
    protocolVersion: 1,
    hostId: "host-local",
    hostGeneration: 1,
    hostSeq: 0,
    migrationStage: "hoststate-authoritative",
    leaseExpiresAt: 1,
    pendingDispatch: 0,
    pendingBroadcast: 0,
  },
})
jest.mock("@/lib/sync/host-state-service", () => ({
  installHostStateSyncForTarget: (...args: unknown[]) => installHostStateSync(...args),
  hostStateStatusAllowsWrites: (status: { migrationStage?: string }) =>
    status.migrationStage === "hoststate-authoritative",
}))
const unregisterResync = jest.fn()
jest.mock("@/lib/tauri/resync-coordinator", () => ({
  remoteEventResyncCoordinator: {
    register: jest.fn(() => unregisterResync),
  },
}))

jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: jest.fn(),
}))

let runtimeTarget: { id: string } | null = null
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ target: runtimeTarget }),
}))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: () => ({
    host: { compatible: true, operations: ["host_state_submit"], grants: [] },
  }),
  runtimeHostSnapshotFromManifest: () => ({
    compatible: true,
    operations: ["host_state_submit"],
    grants: [],
  }),
  subscribeRuntimeSnapshot: () => () => undefined,
  updateRuntimeSnapshot: jest.fn(),
}))

let transitionParticipant: { run: () => Promise<void> } | null = null
const unregisterTransitionParticipant = jest.fn()
jest.mock("@/lib/runtime/runtime-target-lifecycle", () => ({
  registerRuntimeTargetTransitionParticipant: (participant: { run: () => Promise<void> }) => {
    transitionParticipant = participant
    return unregisterTransitionParticipant
  },
}))

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "acct-web" }),
}))

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: { settings: { mobileRuntimeMode: string } }) => unknown) =>
    selector({ settings: { mobileRuntimeMode: "paired" } }),
}))

const dispatcher: OutboundDispatcher = {
  call: jest.fn().mockResolvedValue(null),
}
const scope = { accountId: "acct-web", targetId: "desktop-studio", routingGeneration: 1 }

beforeEach(() => {
  jest.clearAllMocks()
  pendingObserver = undefined
  runtimeTarget = null
  transitionParticipant = null
  transportCall.mockResolvedValue({
    schemaVersion: 2,
    protocol: { min: 2, max: 2 },
    host: { id: "host-local", version: "test" },
    features: {
      "session.state-sync": {
        version: 1,
        operations: ["host_state_snapshot", "host_state_submit", "host_state_status"],
      },
    },
    operations: [],
    deviceGrants: [],
    transportCapabilities: {},
    limits: {},
  })
})

it("runs on native mobile and drains pending rows", () => {
  render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="mobile"
      webCompanionOverride={false}
      mobilePairedOverride
      scopeOverride={scope}
    />
  )

  expect(createRunner).toHaveBeenCalledWith(
    expect.objectContaining({
      dispatcher,
      enforceMobile: false,
      scope,
      canDispatch: expect.any(Function),
    })
  )
  expect(runner.kick).toHaveBeenCalledTimes(1)
  pendingObserver?.next?.(1)
  expect(runner.kick).toHaveBeenCalledTimes(2)
})

it("uses the stable Host id and default Mobile account on a fresh install", () => {
  runtimeTarget = { id: "host-mobile-a" }

  render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="mobile"
      webCompanionOverride={false}
      mobilePairedOverride
    />
  )

  expect(createRunner).toHaveBeenCalledWith(
    expect.objectContaining({
      dispatcher,
      enforceMobile: false,
      scope: { accountId: "local_acct_a", targetId: "host-mobile-a", routingGeneration: 0 },
      canDispatch: expect.any(Function),
    })
  )
})

it("quiesces through the runtime-target transition before cleanup", async () => {
  const { unmount } = render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="web"
      webCompanionOverride
      scopeOverride={scope}
    />
  )

  await transitionParticipant?.run()
  expect(runner.quiesce).toHaveBeenCalledTimes(1)
  unmount()
  expect(unregisterTransitionParticipant).toHaveBeenCalledTimes(1)
  expect(runner.stop).toHaveBeenCalledTimes(1)
})

it("runs in an ordinary browser only when a Companion target exists", () => {
  const { rerender } = render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="web"
      webCompanionOverride={false}
      scopeOverride={scope}
    />
  )
  expect(createRunner).not.toHaveBeenCalled()

  rerender(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="web"
      webCompanionOverride
      scopeOverride={scope}
    />
  )
  expect(createRunner).toHaveBeenCalledWith(
    expect.objectContaining({
      dispatcher,
      enforceMobile: false,
      scope,
      canDispatch: expect.any(Function),
    })
  )
})

it("stops and unsubscribes on target deactivation", () => {
  const { rerender } = render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="web"
      webCompanionOverride
      scopeOverride={scope}
    />
  )

  rerender(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="web"
      webCompanionOverride={false}
      scopeOverride={scope}
    />
  )

  expect(unsubscribe).toHaveBeenCalledTimes(1)
  expect(runner.stop).toHaveBeenCalledTimes(1)
})

it("runs and installs HostState synchronization on the Tauri host", async () => {
  const { unmount } = render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="tauri"
      scopeOverride={scope}
    />
  )
  expect(createRunner).toHaveBeenCalledWith(
    expect.objectContaining({
      dispatcher,
      enforceMobile: false,
      scope,
      canDispatch: expect.any(Function),
    })
  )
  await waitFor(() =>
    expect(installHostStateSync).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: scope.accountId, runtimeTargetId: scope.targetId })
    )
  )
  unmount()
  expect(stopHostStateSync).toHaveBeenCalledTimes(1)
  expect(unregisterResync).toHaveBeenCalledTimes(1)
})
