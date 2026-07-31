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

const runner = {
  kick: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn(),
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
