/**
 * Unit tests for `MobileOutboundRunnerProvider` — the mount point that
 * actually drains the mobile outbound queue in production.
 *
 * Before this provider existed, every enqueued row sat in Dexie forever.
 * These tests guard the contract that (a) the runner is constructed on
 * `usePlatform() === "mobile"`, (b) it kicks immediately so a row queued
 * while backgrounded drains on resume, (c) the runner is stopped on
 * unmount, and (d) non-mobile platforms allocate nothing.
 */

import { render } from "@testing-library/react"

import { MobileOutboundRunnerProvider } from "./mobile-outbound-runner-provider"
import type { OutboundDispatcher } from "@/lib/queue/outbound-queue"

let mockPendingObserver: { next?: (count: number) => void } | undefined
const mockPendingUnsubscribe = jest.fn()
const mockLiveQuery = jest.fn((_query?: unknown) => ({
  subscribe: jest.fn((observer: { next?: (count: number) => void }) => {
    mockPendingObserver = observer
    return { unsubscribe: mockPendingUnsubscribe }
  }),
}))

jest.mock("dexie", () => ({
  liveQuery: (query: unknown) => mockLiveQuery(query),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    mobileOutboundQueue: {
      where: () => ({ equals: () => ({ count: jest.fn().mockResolvedValue(0) }) }),
    },
  }),
}))

// Mock the outbound-queue factory so we can observe construct + kick + stop.
const fakeRunner = {
  kick: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn(),
  isDraining: jest.fn().mockReturnValue(false),
}
const fakeFactory = jest.fn((_opts: unknown) => fakeRunner)

jest.mock("@/lib/queue/outbound-queue", () => ({
  createOutboundRunner: (opts: unknown) => fakeFactory(opts),
}))

const transportCall = jest.fn().mockResolvedValue({ ok: true })
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => transportCall(...args) },
}))

const runSyncDownMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/sync/companion-sync", () => ({
  runSyncDown: (...args: unknown[]) => runSyncDownMock(...args),
}))

const fakeDispatcher: OutboundDispatcher = {
  async call() {
    return null
  },
}

beforeEach(() => {
  fakeFactory.mockClear()
  fakeRunner.kick.mockClear()
  fakeRunner.stop.mockClear()
  transportCall.mockClear()
  runSyncDownMock.mockClear()
  mockLiveQuery.mockClear()
  mockPendingUnsubscribe.mockClear()
  mockPendingObserver = undefined
})

describe("MobileOutboundRunnerProvider", () => {
  it("constructs and kicks the runner on mobile", () => {
    render(<MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="mobile" />)
    expect(fakeFactory).toHaveBeenCalledTimes(1)
    expect(fakeFactory).toHaveBeenCalledWith({ dispatcher: fakeDispatcher })
    expect(fakeRunner.kick).toHaveBeenCalledTimes(1)
  })

  it("kicks again when a pending row is enqueued while already online", () => {
    render(<MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="mobile" />)
    expect(mockLiveQuery).toHaveBeenCalledTimes(1)

    mockPendingObserver?.next?.(1)

    expect(fakeRunner.kick).toHaveBeenCalledTimes(2)
  })

  it("stops the runner on unmount", () => {
    const { unmount } = render(
      <MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="mobile" />
    )
    expect(fakeRunner.stop).not.toHaveBeenCalled()
    unmount()
    expect(fakeRunner.stop).toHaveBeenCalledTimes(1)
    expect(mockPendingUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it("does NOT construct a runner on the web platform", () => {
    render(<MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="web" />)
    expect(fakeFactory).not.toHaveBeenCalled()
    expect(fakeRunner.kick).not.toHaveBeenCalled()
  })

  it("does NOT construct a runner on the tauri platform", () => {
    render(<MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="tauri" />)
    expect(fakeFactory).not.toHaveBeenCalled()
  })

  it("survives a kick rejection without crashing", async () => {
    fakeRunner.kick.mockRejectedValueOnce(new Error("network down"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    render(<MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="mobile" />)
    // Let the rejected promise propagate to the .catch handler.
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith("mobile-outbound-runner: kick failed", expect.any(Error))
    warn.mockRestore()
  })

  describe("liveDispatcher post-trigger run sync", () => {
    // With no `dispatcher` prop the provider builds the production
    // `liveDispatcher`; the mocked factory lets us capture and invoke it.
    function captureLiveDispatcher(): OutboundDispatcher {
      render(<MobileOutboundRunnerProvider platformOverride="mobile" />)
      const opts = fakeFactory.mock.calls[0]?.[0] as { dispatcher: OutboundDispatcher }
      return opts.dispatcher
    }

    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it("pulls workflowRuns shortly after a manual trigger is dispatched", async () => {
      const dispatcher = captureLiveDispatcher()
      await dispatcher.call("workflow_trigger_manual", { workflowId: "w1" }, { idempotencyKey: "k" })
      expect(transportCall).toHaveBeenCalledWith("workflow_trigger_manual", { workflowId: "w1" })
      expect(runSyncDownMock).not.toHaveBeenCalled()
      jest.advanceTimersByTime(2500)
      expect(runSyncDownMock).toHaveBeenCalledWith({ only: ["workflowRuns"] })
    })

    it("does not schedule a run sync for non-trigger commands", async () => {
      const dispatcher = captureLiveDispatcher()
      await dispatcher.call("connector_send", { foo: 1 }, { idempotencyKey: "k" })
      jest.advanceTimersByTime(5000)
      expect(runSyncDownMock).not.toHaveBeenCalled()
    })
  })

  it("recreates the runner when platform flips from web to mobile", () => {
    const { rerender } = render(
      <MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="web" />
    )
    expect(fakeFactory).not.toHaveBeenCalled()

    rerender(<MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="mobile" />)
    expect(fakeFactory).toHaveBeenCalledTimes(1)
    expect(fakeRunner.kick).toHaveBeenCalledTimes(1)
  })
})
