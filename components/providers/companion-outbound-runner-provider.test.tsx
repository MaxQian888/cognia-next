import { render } from "@testing-library/react"

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

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: jest.fn(),
}))

let runtimeTarget: { id: string } | null = null
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ target: runtimeTarget }),
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
const scope = { accountId: "acct-web", targetId: "desktop-studio" }

beforeEach(() => {
  jest.clearAllMocks()
  pendingObserver = undefined
  runtimeTarget = null
  transitionParticipant = null
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

  expect(createRunner).toHaveBeenCalledWith({
    dispatcher,
    enforceMobile: false,
    scope,
  })
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

  expect(createRunner).toHaveBeenCalledWith({
    dispatcher,
    enforceMobile: false,
    scope: { accountId: "local_acct_a", targetId: "host-mobile-a" },
  })
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
  expect(createRunner).toHaveBeenCalledWith({
    dispatcher,
    enforceMobile: false,
    scope,
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

it("never runs on the Tauri host", () => {
  render(
    <CompanionOutboundRunnerProvider
      dispatcher={dispatcher}
      platformOverride="tauri"
      webCompanionOverride
      scopeOverride={scope}
    />
  )
  expect(createRunner).not.toHaveBeenCalled()
})
