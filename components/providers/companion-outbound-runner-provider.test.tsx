import { act, render, waitFor } from "@testing-library/react"
import { toast } from "sonner"

import type { OutboundDispatcher } from "@/lib/queue/outbound-queue"
import {
  clearActiveRuntimeTargetContext,
  getActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
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

jest.mock("sonner", () => ({
  toast: { loading: jest.fn(), dismiss: jest.fn() },
}))

let mockApprovalState: "not-required" | "held" | "blocked" = "not-required"
const mockClearApproval = jest.fn()
let mockConsentCode: string | null = null
let mockHasReporter = false
const approvalListeners = new Set<() => void>()
jest.mock("@/lib/queue/outbound-approval", () => ({
  PENDING_NO_CODE: "pending",
  ensureOutboundApproval: async () => mockApprovalState,
  clearOutboundApproval: () => mockClearApproval(),
  withOutboundApproval: (_command: string, payload: unknown) => payload,
  outboundConsentCode: () => mockConsentCode,
  hasOutboundApprovalReporter: () => mockHasReporter,
  subscribeOutboundApproval: (listener: () => void) => {
    approvalListeners.add(listener)
    return () => approvalListeners.delete(listener)
  },
}))

jest.mock("@/lib/platform/host-feature-manifest", () => ({
  parseHostFeatureManifest: (value: unknown) => value,
}))

const transportCall = jest.fn()
// The provider subscribes to `host-consent://requested` so a lease approved on
// another screen resumes the frozen queue. `subscribe` must hand back a real
// unsubscribe: the effect's cleanup calls it.
const consentUnsubscribe = jest.fn()
let consentHandler: ((request: { state: string }) => void) | undefined
const transportSubscribe = jest.fn((_channel: string, handler: (request: never) => void) => {
  consentHandler = handler as (request: { state: string }) => void
  return consentUnsubscribe
})
jest.mock("@/lib/tauri", () => ({
  transport: {
    call: (...args: unknown[]) => transportCall(...args),
    subscribe: (...args: unknown[]) =>
      transportSubscribe(...(args as [string, (request: never) => void])),
  },
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
  clearActiveRuntimeTargetContext()
  pendingObserver = undefined
  consentHandler = undefined
  mockApprovalState = "not-required"
  mockConsentCode = null
  mockHasReporter = false
  approvalListeners.clear()
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

it("refuses to route a Web companion through the snapshot's placeholder id", () => {
  // `web-companion` names a surface, not a stored target. Installing it as the
  // routing context is what made a freshly paired browser report "no
  // paired-Host record exists for the active runtime target": the boot
  // provider republishes that opening snapshot on every rebind, so the
  // placeholder landed on top of the real Host id the pairing had just set,
  // and the credential lookup then asked the book for a record nothing files.
  runtimeTarget = { id: "web-companion" }

  render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="web"
      webCompanionOverride
      mobilePairedOverride={false}
    />
  )

  expect(createRunner).not.toHaveBeenCalled()
  expect(getActiveRuntimeTargetContext()?.targetId).not.toBe("web-companion")
})

it("routes as soon as the snapshot carries the real Host id", () => {
  runtimeTarget = { id: "host-web-a" }

  render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="web"
      webCompanionOverride
      mobilePairedOverride={false}
    />
  )

  expect(createRunner).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: expect.objectContaining({ targetId: "host-web-a" }),
    })
  )
  expect(getActiveRuntimeTargetContext()?.targetId).toBe("host-web-a")
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

// The queue drains on mount, on reconnect, on any runtime-snapshot change and
// on any pending row. None of those is a user action, so a leftover row asked
// the Host for host-admin authority with nobody at the keyboard, and a Host
// waiting on a human answered REMOTE_CONSENT_REQUIRED. That reached the queue
// as an ordinary delivery failure, which retried the user's message into the
// deadletter lane while the approval was still on someone's screen.
describe("the interactive-approval gate", () => {
  const canDispatchOf = () =>
    (createRunner.mock.calls.at(-1)?.[0] as { canDispatch: (row: unknown) => Promise<boolean> })
      .canDispatch

  function mountMobile() {
    runtimeTarget = { id: "host-mobile-a" }
    return render(
      <CompanionOutboundRunnerProvider
        dispatcher={dispatcher}
        platformOverride="mobile"
        webCompanionOverride={false}
        mobilePairedOverride
      />
    )
  }

  it("freezes a row the Host is still asking a human about", async () => {
    mountMobile()
    mockApprovalState = "blocked"

    await expect(canDispatchOf()({ command: "host_state_submit", protocol: "rpc" })).resolves.toBe(
      false
    )
  })

  it("lets a row through once the lease is held", async () => {
    mountMobile()
    mockApprovalState = "held"

    await expect(canDispatchOf()({ command: "host_state_submit", protocol: "rpc" })).resolves.toBe(
      true
    )
  })

  it("resumes the queue when an approval is answered on another screen", () => {
    mountMobile()
    const kicks = runner.kick.mock.calls.length

    consentHandler?.({ state: "approved" })

    expect(mockClearApproval).toHaveBeenCalled()
    expect(runner.kick.mock.calls.length).toBeGreaterThan(kicks)
  })

  it("ignores a denial, which is not something to retry into", () => {
    mountMobile()
    const kicks = runner.kick.mock.calls.length
    const clears = mockClearApproval.mock.calls.length

    consentHandler?.({ state: "denied" })

    expect(mockClearApproval.mock.calls.length).toBe(clears)
    expect(runner.kick.mock.calls.length).toBe(kicks)
  })

  it("drops the previous target's approval state when the scope moves", () => {
    // The lease is host-bound. Carrying Host A's answer — a live token, or a
    // "waiting on a human" banner — into Host B's session is a credential and
    // a status belonging to a host nobody is dispatching to any more.
    const hostA = { accountId: "acct_a", targetId: "host-a", routingGeneration: 1 }
    const hostB = { accountId: "acct_a", targetId: "host-b", routingGeneration: 2 }
    const { rerender } = render(
      <CompanionOutboundRunnerProvider
        dispatcher={dispatcher}
        platformOverride="web"
        webCompanionOverride
        scopeOverride={hostA}
      />
    )
    const clears = mockClearApproval.mock.calls.length

    rerender(
      <CompanionOutboundRunnerProvider
        dispatcher={dispatcher}
        platformOverride="web"
        webCompanionOverride
        scopeOverride={hostB}
      />
    )

    // Once on the way out of Host A, once on the way into Host B.
    expect(mockClearApproval.mock.calls.length).toBe(clears + 2)
    expect(getActiveRuntimeTargetContext()).toEqual(hostB)
  })

  it("drops the approval state when the target is deactivated altogether", () => {
    const { unmount } = render(
      <CompanionOutboundRunnerProvider
        dispatcher={dispatcher}
        platformOverride="web"
        webCompanionOverride
        scopeOverride={{ accountId: "acct_a", targetId: "host-a", routingGeneration: 1 }}
      />
    )
    const clears = mockClearApproval.mock.calls.length

    unmount()

    expect(mockClearApproval.mock.calls.length).toBe(clears + 1)
  })
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

describe("reporting a Host that is waiting on a human", () => {
  // The gate freezes a row for any `companion` target, including a paired
  // desktop browser. Only the mobile shells mount `OfflineBanner`, so without
  // this the composer cleared, no turn started, and nothing anywhere said why.
  it("raises a toast on a shell with no inline surface", async () => {
    render(
      <CompanionOutboundRunnerProvider
        dispatcher={dispatcher}
        platformOverride="web"
        webCompanionOverride
        scopeOverride={scope}
      />
    )

    mockConsentCode = "742519"
    act(() => approvalListeners.forEach((listener) => listener()))

    await waitFor(() => expect(toast.loading).toHaveBeenCalled())
    expect(toast.loading).toHaveBeenCalledWith(
      expect.stringContaining("742519"),
      expect.objectContaining({ id: "outbound-approval-pending", duration: Infinity })
    )
  })

  it("stays quiet while a banner is already reporting the same wait", () => {
    mockHasReporter = true
    render(
      <CompanionOutboundRunnerProvider
        dispatcher={dispatcher}
        platformOverride="mobile"
        webCompanionOverride={false}
        mobilePairedOverride
        scopeOverride={scope}
      />
    )

    mockConsentCode = "742519"
    act(() => approvalListeners.forEach((listener) => listener()))

    expect(toast.loading).not.toHaveBeenCalled()
  })

  it("clears the toast once the approval is answered", async () => {
    render(
      <CompanionOutboundRunnerProvider
        dispatcher={dispatcher}
        platformOverride="web"
        webCompanionOverride
        scopeOverride={scope}
      />
    )

    mockConsentCode = "742519"
    act(() => approvalListeners.forEach((listener) => listener()))
    await waitFor(() => expect(toast.loading).toHaveBeenCalled())

    mockConsentCode = null
    act(() => approvalListeners.forEach((listener) => listener()))

    expect(toast.dismiss).toHaveBeenCalledWith("outbound-approval-pending")
  })
})
