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

const fakeDispatcher: OutboundDispatcher = {
  async call() {
    return null
  },
}

beforeEach(() => {
  fakeFactory.mockClear()
  fakeRunner.kick.mockClear()
  fakeRunner.stop.mockClear()
})

describe("MobileOutboundRunnerProvider", () => {
  it("constructs and kicks the runner on mobile", () => {
    render(<MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="mobile" />)
    expect(fakeFactory).toHaveBeenCalledTimes(1)
    expect(fakeFactory).toHaveBeenCalledWith({ dispatcher: fakeDispatcher })
    expect(fakeRunner.kick).toHaveBeenCalledTimes(1)
  })

  it("stops the runner on unmount", () => {
    const { unmount } = render(
      <MobileOutboundRunnerProvider dispatcher={fakeDispatcher} platformOverride="mobile" />
    )
    expect(fakeRunner.stop).not.toHaveBeenCalled()
    unmount()
    expect(fakeRunner.stop).toHaveBeenCalledTimes(1)
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
    expect(warn).toHaveBeenCalledWith(
      "mobile-outbound-runner: initial kick failed",
      expect.any(Error)
    )
    warn.mockRestore()
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
