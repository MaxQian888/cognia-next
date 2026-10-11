import { act, renderHook } from "@testing-library/react"

import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type { GlanceRequestResult } from "@/lib/glance/requests"

jest.mock("@/lib/tauri/glance", () => ({
  GLANCE_LEASE_RENEW_MS: 20_000,
  onGlanceResult: jest.fn(),
  onGlanceSnapshot: jest.fn(),
  sendGlanceRequest: jest.fn(),
  sendGlanceSubscription: jest.fn(),
}))

import {
  GLANCE_LEASE_RENEW_MS,
  onGlanceResult,
  onGlanceSnapshot,
  sendGlanceRequest,
  sendGlanceSubscription,
} from "@/lib/tauri/glance"

import { GLANCE_REQUEST_TIMEOUT_MS, useGlanceConsumer } from "./use-glance-consumer"

const onSnapshotMock = onGlanceSnapshot as jest.Mock
const onResultMock = onGlanceResult as jest.Mock
const sendRequestMock = sendGlanceRequest as jest.Mock
const sendSubscriptionMock = sendGlanceSubscription as jest.Mock

function snapshot(epoch: number, revision: number): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch,
    revision,
    generatedAt: 1_000 + revision,
    config: {} as GlanceSnapshotV1["config"],
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
    actions: [],
  }
}

/** Flush the promise chains that register listeners. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("useGlanceConsumer", () => {
  let snapshotHandler: (payload: unknown) => void
  let resultHandler: (result: GlanceRequestResult) => void
  let offSnapshot: jest.Mock
  let offResult: jest.Mock
  let uuidCounter: number
  let randomUuidSpy: jest.SpyInstance | null = null
  let clearTimeoutSpy: jest.SpyInstance
  const realRandomUuid = globalThis.crypto?.randomUUID

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    clearTimeoutSpy = jest.spyOn(globalThis, "clearTimeout")
    offSnapshot = jest.fn()
    offResult = jest.fn()
    snapshotHandler = () => {}
    resultHandler = () => {}
    onSnapshotMock.mockImplementation(async (handler: (payload: unknown) => void) => {
      snapshotHandler = handler
      return offSnapshot
    })
    onResultMock.mockImplementation(async (handler: (result: GlanceRequestResult) => void) => {
      resultHandler = handler
      return offResult
    })
    sendRequestMock.mockResolvedValue(true)
    sendSubscriptionMock.mockResolvedValue(true)
    uuidCounter = 0
    if (typeof globalThis.crypto?.randomUUID === "function") {
      randomUuidSpy = jest
        .spyOn(globalThis.crypto, "randomUUID")
        .mockImplementation(
          () => `req-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
        )
    } else {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: { ...(globalThis.crypto ?? {}), randomUUID: () => `req-${++uuidCounter}` },
      })
    }
  })

  afterEach(() => {
    jest.useRealTimers()
    clearTimeoutSpy.mockRestore()
    randomUuidSpy?.mockRestore()
    randomUuidSpy = null
    if (realRandomUuid && globalThis.crypto && globalThis.crypto.randomUUID !== realRandomUuid) {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: realRandomUuid,
      })
    }
  })

  describe("lease", () => {
    it("announces a visible lease on mount", async () => {
      renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      expect(sendSubscriptionMock).toHaveBeenCalledTimes(1)
      expect(sendSubscriptionMock).toHaveBeenCalledWith({
        consumer: "tray-panel",
        windowLabel: "tray",
        visible: true,
      })
    })

    it("renews the lease every GLANCE_LEASE_RENEW_MS", async () => {
      renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      sendSubscriptionMock.mockClear()

      act(() => {
        jest.advanceTimersByTime(GLANCE_LEASE_RENEW_MS - 1)
      })
      expect(sendSubscriptionMock).not.toHaveBeenCalled()

      act(() => {
        jest.advanceTimersByTime(1)
      })
      expect(sendSubscriptionMock).toHaveBeenCalledTimes(1)

      act(() => {
        jest.advanceTimersByTime(GLANCE_LEASE_RENEW_MS * 2)
      })
      expect(sendSubscriptionMock).toHaveBeenCalledTimes(3)
      for (const call of sendSubscriptionMock.mock.calls) {
        expect(call[0]).toEqual({ consumer: "tray-panel", windowLabel: "tray", visible: true })
      }
    })

    it("sends visible:false when hidden and never renews", async () => {
      renderHook(() => useGlanceConsumer("tray-panel", "tray", false))
      await flush()
      expect(sendSubscriptionMock).toHaveBeenCalledTimes(1)
      expect(sendSubscriptionMock).toHaveBeenCalledWith({
        consumer: "tray-panel",
        windowLabel: "tray",
        visible: false,
      })

      act(() => {
        jest.advanceTimersByTime(GLANCE_LEASE_RENEW_MS * 5)
      })
      expect(sendSubscriptionMock).toHaveBeenCalledTimes(1)
    })

    it("ends the lease and stops renewing when the window turns hidden", async () => {
      const { rerender } = renderHook(
        ({ visible }: { visible: boolean }) => useGlanceConsumer("tray-panel", "tray", visible),
        { initialProps: { visible: true } }
      )
      await flush()
      sendSubscriptionMock.mockClear()

      rerender({ visible: false })
      expect(sendSubscriptionMock).toHaveBeenCalledTimes(1)
      expect(sendSubscriptionMock).toHaveBeenLastCalledWith({
        consumer: "tray-panel",
        windowLabel: "tray",
        visible: false,
      })

      act(() => {
        jest.advanceTimersByTime(GLANCE_LEASE_RENEW_MS * 3)
      })
      expect(sendSubscriptionMock).toHaveBeenCalledTimes(1)
    })

    it("re-announces when the window becomes visible again", async () => {
      const { rerender } = renderHook(
        ({ visible }: { visible: boolean }) => useGlanceConsumer("tray-panel", "tray", visible),
        { initialProps: { visible: false } }
      )
      await flush()
      sendSubscriptionMock.mockClear()

      rerender({ visible: true })
      expect(sendSubscriptionMock).toHaveBeenCalledWith({
        consumer: "tray-panel",
        windowLabel: "tray",
        visible: true,
      })
    })

    it("stops renewing on unmount", async () => {
      const { unmount } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      unmount()
      sendSubscriptionMock.mockClear()
      act(() => {
        jest.advanceTimersByTime(GLANCE_LEASE_RENEW_MS * 3)
      })
      expect(sendSubscriptionMock).not.toHaveBeenCalled()
    })
  })

  describe("snapshots", () => {
    it("starts with no snapshot", async () => {
      const { result } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      expect(result.current.snapshot).toBeNull()
    })

    it("keeps the newest revision and ignores an older one in the same epoch", async () => {
      const { result } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()

      act(() => snapshotHandler(snapshot(1, 5)))
      expect(result.current.snapshot?.revision).toBe(5)

      act(() => snapshotHandler(snapshot(1, 4)))
      expect(result.current.snapshot?.revision).toBe(5)

      act(() => snapshotHandler(snapshot(1, 5)))
      expect(result.current.snapshot?.revision).toBe(5)

      act(() => snapshotHandler(snapshot(1, 6)))
      expect(result.current.snapshot?.revision).toBe(6)
    })

    it("starts receivedCount at 0", async () => {
      const { result } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      expect(result.current.receivedCount).toBe(0)
    })

    it("counts only snapshots that were newer than the one held", async () => {
      const { result } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()

      act(() => snapshotHandler(snapshot(1, 5)))
      expect(result.current.receivedCount).toBe(1)

      // Older, equal and invalid snapshots are not "received".
      act(() => snapshotHandler(snapshot(1, 4)))
      act(() => snapshotHandler(snapshot(1, 5)))
      act(() => snapshotHandler({ version: 2 }))
      act(() => snapshotHandler(null))
      expect(result.current.receivedCount).toBe(1)

      act(() => snapshotHandler(snapshot(1, 6)))
      expect(result.current.receivedCount).toBe(2)

      // A new epoch is newer whatever its revision.
      act(() => snapshotHandler(snapshot(2, 1)))
      expect(result.current.receivedCount).toBe(3)
    })

    it("accepts a new epoch even with a lower revision", async () => {
      const { result } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()

      act(() => snapshotHandler(snapshot(1, 900)))
      act(() => snapshotHandler(snapshot(2, 1)))
      expect(result.current.snapshot).toMatchObject({ epoch: 2, revision: 1 })
    })

    it.each([[null], [undefined], ["x"], [{ version: 2 }], [{ version: 1, epoch: "1" }]])(
      "ignores an invalid payload %j",
      async (payload) => {
        const { result } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
        await flush()

        act(() => snapshotHandler(snapshot(1, 1)))
        act(() => snapshotHandler(payload))
        expect(result.current.snapshot).toMatchObject({ epoch: 1, revision: 1 })
      }
    )

    it("ignores snapshots that arrive after unmount", async () => {
      const { result, unmount } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      unmount()
      expect(() => act(() => snapshotHandler(snapshot(1, 1)))).not.toThrow()
      expect(result.current.snapshot).toBeNull()
    })
  })

  describe("send", () => {
    async function setup() {
      const hook = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      return hook
    }

    it("carries requestId and consumer alongside the body", async () => {
      const { result } = await setup()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "open-fleet", rowId: "row-1", filter: "failed" })
      })
      expect(sendRequestMock).toHaveBeenCalledWith({
        kind: "open-fleet",
        rowId: "row-1",
        filter: "failed",
        requestId: "req-1",
        consumer: "tray-panel",
      })
      act(() => resultHandler({ requestId: "req-1", ok: true }))
      await expect(promise).resolves.toBeNull()
    })

    it("uses a fresh requestId per call", async () => {
      const { result } = await setup()
      act(() => {
        void result.current.send({ kind: "refresh" })
        void result.current.send({ kind: "refresh" })
      })
      const ids = sendRequestMock.mock.calls.map((c) => c[0].requestId)
      expect(ids).toEqual(["req-1", "req-2"])
    })

    it("resolves null on an ok result", async () => {
      const { result } = await setup()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "refresh" })
      })
      act(() => resultHandler({ requestId: "req-1", ok: true }))
      await expect(promise).resolves.toBeNull()
    })

    it("resolves the errorKey on a failure result", async () => {
      const { result } = await setup()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "refresh" })
      })
      act(() => resultHandler({ requestId: "req-1", ok: false, errorKey: "errors.noFleet" }))
      await expect(promise).resolves.toBe("errors.noFleet")
    })

    it("falls back to errors.requestFailed when the failure has no errorKey", async () => {
      const { result } = await setup()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "refresh" })
      })
      act(() => resultHandler({ requestId: "req-1", ok: false }))
      await expect(promise).resolves.toBe("errors.requestFailed")
    })

    it("resolves errors.deliveryFailed when the request could not be sent", async () => {
      sendRequestMock.mockResolvedValue(false)
      const { result } = await setup()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "refresh" })
      })
      await expect(promise).resolves.toBe("errors.deliveryFailed")
      expect(clearTimeoutSpy).toHaveBeenCalled()
    })

    it("resolves errors.timeout when no result arrives", async () => {
      const { result } = await setup()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "refresh" })
      })
      act(() => {
        jest.advanceTimersByTime(GLANCE_REQUEST_TIMEOUT_MS)
      })
      await expect(promise).resolves.toBe("errors.timeout")
    })

    it("ignores a result that arrives after the timeout", async () => {
      const { result } = await setup()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "refresh" })
      })
      act(() => {
        jest.advanceTimersByTime(GLANCE_REQUEST_TIMEOUT_MS)
      })
      await expect(promise).resolves.toBe("errors.timeout")
      expect(() => act(() => resultHandler({ requestId: "req-1", ok: true }))).not.toThrow()
    })

    it("ignores a result for an unknown requestId", async () => {
      const { result } = await setup()
      let promise!: Promise<string | null>
      let settled = false
      act(() => {
        promise = result.current.send({ kind: "refresh" })
        void promise.then(() => {
          settled = true
        })
      })
      act(() => resultHandler({ requestId: "other", ok: true }))
      await Promise.resolve()
      expect(settled).toBe(false)
      act(() => resultHandler({ requestId: "req-1", ok: true }))
      await expect(promise).resolves.toBeNull()
    })

    it("does not time out a request that already got a result", async () => {
      const { result } = await setup()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "refresh" })
      })
      act(() => resultHandler({ requestId: "req-1", ok: true }))
      await expect(promise).resolves.toBeNull()
      expect(clearTimeoutSpy).toHaveBeenCalled()
    })

    it("pairs concurrent requests with their own results", async () => {
      const { result } = await setup()
      let first!: Promise<string | null>
      let second!: Promise<string | null>
      act(() => {
        first = result.current.send({ kind: "refresh" })
        second = result.current.send({ kind: "quota-refresh", key: "k" })
      })
      act(() => resultHandler({ requestId: "req-2", ok: false, errorKey: "errors.x" }))
      act(() => resultHandler({ requestId: "req-1", ok: true }))
      await expect(first).resolves.toBeNull()
      await expect(second).resolves.toBe("errors.x")
    })
  })

  describe("unmount", () => {
    it("resolves in-flight sends with errors.requestFailed and clears their timers", async () => {
      const { result, unmount } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      let promise!: Promise<string | null>
      act(() => {
        promise = result.current.send({ kind: "refresh" })
      })
      unmount()
      await expect(promise).resolves.toBe("errors.requestFailed")
      expect(clearTimeoutSpy).toHaveBeenCalled()
    })

    it("unsubscribes both listeners", async () => {
      const { unmount } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      await flush()
      unmount()
      expect(offSnapshot).toHaveBeenCalledTimes(1)
      expect(offResult).toHaveBeenCalledTimes(1)
    })

    it("unsubscribes a listener that finishes registering after unmount", async () => {
      let resolveSnapshot!: (off: () => void) => void
      onSnapshotMock.mockImplementationOnce(
        () =>
          new Promise<() => void>((resolve) => {
            resolveSnapshot = resolve
          })
      )
      const { unmount } = renderHook(() => useGlanceConsumer("tray-panel", "tray", true))
      unmount()
      expect(offSnapshot).not.toHaveBeenCalled()
      await act(async () => {
        resolveSnapshot(offSnapshot)
        await Promise.resolve()
      })
      expect(offSnapshot).toHaveBeenCalledTimes(1)
    })
  })
})
