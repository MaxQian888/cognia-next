/** @jest-environment jsdom */

import { isTauri } from "@/lib/platform/detect"
import {
  acknowledgeTranscriptRuntime,
  invalidateTranscriptRuntime,
  publishTranscriptRevision,
  withTranscriptRuntimeLock,
  createTranscriptRuntimeFence,
} from "./revision-events"

const emit = jest.fn()
const closeSession = jest.fn()
const updateSession = jest.fn()
const sessionGet = jest.fn()
const sessionUpdate = jest.fn()
let databaseName = "runtime-lock-test"
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    name: databaseName,
    sessions: { get: sessionGet, update: sessionUpdate },
    transaction: async (_mode: unknown, _table: unknown, callback: () => Promise<void>) =>
      callback(),
  }),
}))

describe("withTranscriptRuntimeLock", () => {
  it("refuses a queued action when the database changes before lock admission", async () => {
    const action = jest.fn(async () => "sent")
    const request = jest.fn(async (_key: string, run: () => Promise<string>) => {
      databaseName = "different-account"
      return run()
    })
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } })
    try {
      await expect(withTranscriptRuntimeLock("s1", action)).rejects.toThrow(
        "Transcript database changed while waiting for runtime lock"
      )
      expect(action).not.toHaveBeenCalled()
    } finally {
      databaseName = "runtime-lock-test"
      Object.defineProperty(navigator, "locks", { configurable: true, value: undefined })
    }
  })

  it("does not let a send hydrate between runtime invalidation and mutation commit", async () => {
    let releaseMutation!: () => void
    let enteredMutation!: () => void
    const entered = new Promise<void>((resolve) => {
      enteredMutation = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    let transcript = "old"
    const mutation = withTranscriptRuntimeLock("locked", async () => {
      enteredMutation()
      await barrier
      transcript = "surviving"
    })
    await entered
    const hydrate = jest.fn(async () => transcript)
    const send = withTranscriptRuntimeLock("locked", hydrate)
    await Promise.resolve()
    await Promise.resolve()
    expect(hydrate).not.toHaveBeenCalled()
    releaseMutation()
    await mutation
    await expect(send).resolves.toBe("surviving")
  })

  it("releases the lane after a rejected mutation", async () => {
    await expect(
      withTranscriptRuntimeLock("failed", async () => {
        throw new Error("refused")
      })
    ).rejects.toThrow("refused")
    await expect(withTranscriptRuntimeLock("failed", async () => "next")).resolves.toBe("next")
  })

  it("uses the same database-scoped Web Lock across renderer windows", async () => {
    const request = jest.fn(async (_key: string, action: () => Promise<string>) => action())
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } })
    try {
      await expect(withTranscriptRuntimeLock("s1", async () => "sent")).resolves.toBe("sent")
      expect(request).toHaveBeenCalledWith(
        "cognia:transcript-runtime:runtime-lock-test:s1",
        expect.any(Function)
      )
    } finally {
      Object.defineProperty(navigator, "locks", { configurable: true, value: undefined })
    }
  })
})
const standalone = jest.fn(() => false)
jest.mock("@/lib/db/sessions", () => ({
  updateSession: (...args: unknown[]) => updateSession(...args),
  getSession: (...args: unknown[]) => sessionGet(...args),
}))
jest.mock("@/lib/claude/ipc", () => ({
  closeSession: (...args: unknown[]) => closeSession(...args),
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({ isStandaloneChatMode: () => standalone() }))
jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@tauri-apps/api/event", () => ({ emit: (...args: unknown[]) => emit(...args) }))

describe("invalidateTranscriptRuntime", () => {
  beforeEach(() => {
    closeSession.mockReset()
    updateSession.mockReset()
    standalone.mockReturnValue(false)
  })

  it("awaits the retained runtime close before allowing a mutation", async () => {
    let finish!: () => void
    closeSession.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    let finished = false
    const task = invalidateTranscriptRuntime("s1").then(() => {
      finished = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(updateSession).not.toHaveBeenCalled()
    finish()
    await task
    expect(closeSession).toHaveBeenCalledWith("s1")
    expect(updateSession).toHaveBeenCalledWith("s1", {
      runtimeTranscriptInvalidated: expect.any(String),
      runtimeTranscriptGeneration: expect.any(String),
    })
  })

  it("fences pending writes before close can finish and accepts only the replacement generation", async () => {
    sessionGet.mockResolvedValue({})
    const cancelled = jest.fn()
    const fence = createTranscriptRuntimeFence(cancelled)
    const pending = await fence.capture("fenced", undefined)
    expect(pending.shouldPersist?.()).toBe(true)
    let finish!: () => void
    closeSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const invalidating = invalidateTranscriptRuntime("fenced")
    while (!finish) await Promise.resolve()
    expect(pending.shouldPersist?.()).toBe(false)
    expect(cancelled).toHaveBeenCalledWith("fenced")
    // The DB still holds the old generation while close is in flight.
    expect((await fence.capture("fenced", undefined)).shouldPersist?.()).toBe(false)
    finish()
    await invalidating
    const generation = updateSession.mock.calls.at(-1)![1].runtimeTranscriptGeneration
    expect((await fence.capture("fenced", undefined)).shouldPersist?.()).toBe(false)
    expect((await fence.capture("fenced", generation)).shouldPersist?.()).toBe(true)
    fence.dispose()
  })

  it("propagates close failure instead of approving stale publication", async () => {
    closeSession.mockRejectedValue(new Error("host unavailable"))
    await expect(invalidateTranscriptRuntime("s1")).rejects.toThrow("host unavailable")
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("does not call a nonexistent sidecar in standalone mode", async () => {
    standalone.mockReturnValue(true)
    await invalidateTranscriptRuntime("s1")
    expect(closeSession).not.toHaveBeenCalled()
  })
})

describe("acknowledgeTranscriptRuntime", () => {
  beforeEach(() => {
    sessionGet.mockReset()
    sessionUpdate.mockReset()
  })
  it("clears only the exact generation restored by the initialized runtime", async () => {
    sessionGet.mockResolvedValue({
      runtimeTranscriptInvalidated: "g1",
      sdkSessionId: "native-kept",
    })
    await acknowledgeTranscriptRuntime("s1", "g1")
    expect(sessionUpdate).toHaveBeenCalledWith("s1", { runtimeTranscriptInvalidated: undefined })
  })
  it("preserves a newer invalidation when an old runtime initialization arrives", async () => {
    sessionGet.mockResolvedValue({ runtimeTranscriptInvalidated: "g2" })
    await acknowledgeTranscriptRuntime("s1", "g1")
    expect(sessionUpdate).not.toHaveBeenCalled()
  })
})

describe("publishTranscriptRevision", () => {
  it("accepts a replacement frame before its cross-window notification arrives", async () => {
    sessionGet.mockResolvedValue({ runtimeTranscriptGeneration: "before" })
    const invalidated = jest.fn()
    const fence = createTranscriptRuntimeFence(invalidated)
    const old = await fence.capture("early-frame", "before")
    sessionGet.mockResolvedValue({ runtimeTranscriptGeneration: "after" })
    const current = await fence.capture("early-frame", "after")
    expect(current.shouldPersist?.()).toBe(true)
    expect(old.shouldPersist?.()).toBe(false)
    expect(invalidated).toHaveBeenCalledWith("early-frame")
    sessionGet.mockClear()
    expect((await fence.capture("early-frame", "before")).shouldPersist?.()).toBe(false)
    expect((await fence.capture("early-frame", "before")).shouldPersist?.()).toBe(false)
    expect(sessionGet).toHaveBeenCalledTimes(1)
    sessionGet.mockClear()
    expect((await fence.capture("early-frame", "after")).shouldPersist?.()).toBe(true)
    expect(sessionGet).not.toHaveBeenCalled()
    fence.dispose()
  })

  it("rejects another window's old generation and ignores duplicate notifications", async () => {
    sessionGet.mockResolvedValue({ runtimeTranscriptGeneration: "before" })
    const invalidated = jest.fn()
    const fence = createTranscriptRuntimeFence(invalidated)
    const old = await fence.capture("other-window", "before")
    sessionGet.mockResolvedValue({ runtimeTranscriptGeneration: "after" })
    const notify = () =>
      window.dispatchEvent(
        new CustomEvent("transcript://revision", {
          detail: {
            sessionId: "other-window",
            revision: 4,
            databaseName: "runtime-lock-test",
            runtimeGeneration: "after",
          },
        })
      )
    notify()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const current = await fence.capture("other-window", "after")
    notify()
    expect(old.shouldPersist?.()).toBe(false)
    expect(current.shouldPersist?.()).toBe(true)
    expect(invalidated).toHaveBeenCalledTimes(1)
    fence.dispose()
    // Unmount flushes still have the DB generation guard after listener cleanup.
    expect(current.shouldPersist?.()).toBe(true)
  })

  it("restores admission after a failed close without reviving previously queued writes", async () => {
    standalone.mockReturnValue(false)
    sessionGet.mockResolvedValue({ runtimeTranscriptGeneration: "preserved" })
    const fence = createTranscriptRuntimeFence(jest.fn())
    const pending = await fence.capture("failed-close", "preserved")
    closeSession.mockRejectedValueOnce(new Error("offline"))
    await expect(invalidateTranscriptRuntime("failed-close")).rejects.toThrow("offline")
    expect(pending.shouldPersist?.()).toBe(false)
    expect((await fence.capture("failed-close", "preserved")).shouldPersist?.()).toBe(true)
    fence.dispose()
  })
  it("dispatches a local event without requiring Tauri", async () => {
    const listener = jest.fn()
    window.addEventListener("transcript://revision", listener)

    await publishTranscriptRevision("s1", 4)

    expect(listener).toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    window.removeEventListener("transcript://revision", listener)
  })

  // The defect: only Tauri was tried, so the headless brain — which keeps a
  // paired browser's replies — never told that browser its transcript moved.
  it("publishes through the headless brain's host-event publisher", async () => {
    const { setHostEventPublisher } = await import("@/lib/companion/host-event-publisher")
    const publisher = jest.fn()
    const release = setHostEventPublisher(publisher)
    try {
      await publishTranscriptRevision("s1", 6)
    } finally {
      release()
    }

    expect(publisher).toHaveBeenCalledWith("transcript://revision", {
      sessionId: "s1",
      revision: 6,
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it("forwards the bounded revision envelope through Tauri", async () => {
    ;(isTauri as jest.Mock).mockReturnValueOnce(true)

    await publishTranscriptRevision("s1", 5)

    expect(emit).toHaveBeenCalledWith("transcript://revision", {
      sessionId: "s1",
      revision: 5,
    })
  })
})
