/**
 * @jest-environment node
 *
 * The headless brain installs `globalThis.window = globalThis` (a bare shim
 * for fake-indexeddb) with no DOM event surface. Leader election must treat
 * that as "single process, always leader" instead of reaching for
 * `window.addEventListener` and throwing out of scheduler initialization.
 */

jest.mock("@cognia/logging", () => {
  const stub = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { loggers: { app: stub, scheduler: stub, store: stub, plugin: stub } }
})

import { isLeaderTab, startLeaderElection, stopLeaderElection } from "./tab-lock"

describe("tab-lock on Node", () => {
  afterEach(() => {
    stopLeaderElection()
    delete (globalThis as { window?: unknown }).window
  })

  it("is always leader when there is no window at all", async () => {
    await startLeaderElection()
    expect(isLeaderTab()).toBe(true)
  })

  it("treats the headless globalThis window shim as a single process (no addEventListener)", async () => {
    ;(globalThis as { window?: unknown }).window = globalThis
    expect(typeof (globalThis as { addEventListener?: unknown }).addEventListener).toBe("undefined")
    await expect(startLeaderElection()).resolves.toBeUndefined()
    expect(isLeaderTab()).toBe(true)
    // stop must not throw either (no removeEventListener on the shim)
    expect(() => stopLeaderElection()).not.toThrow()
  })
})
