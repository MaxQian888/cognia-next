jest.mock("@tauri-apps/api/event", () => ({ emitTo: jest.fn(), listen: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@cognia/logging", () => ({ loggers: { tray: { warn: jest.fn() } } }))

import { loggers } from "@cognia/logging"
import { emitTo, listen } from "@tauri-apps/api/event"

import type { GlanceRequest, GlanceRequestResult } from "@/lib/glance/requests"
import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { isTauri } from "@/lib/tauri"

import {
  GLANCE_LEASE_RENEW_MS,
  GLANCE_LEASE_TTL_MS,
  GLANCE_MAIN_WINDOW_LABEL,
  GLANCE_REQUEST_EVENT,
  GLANCE_RESULT_EVENT,
  GLANCE_SNAPSHOT_EVENT,
  GLANCE_SUBSCRIBE_EVENT,
  isGlanceSubscription,
  onGlanceRequest,
  onGlanceResult,
  onGlanceSnapshot,
  onGlanceSubscription,
  sendGlanceRequest,
  sendGlanceResult,
  sendGlanceSnapshot,
  sendGlanceSubscription,
  type GlanceSubscription,
} from "./glance"

const emitToMock = emitTo as jest.Mock
const listenMock = listen as jest.Mock
const isTauriMock = isTauri as jest.Mock
const warnMock = loggers.tray.warn as jest.Mock

const subscription: GlanceSubscription = {
  consumer: "tray-panel",
  windowLabel: "tray-panel",
  visible: true,
}
const request = { requestId: "r1", consumer: "tray-panel", kind: "refresh" } as GlanceRequest
const result: GlanceRequestResult = { requestId: "r1", ok: true }
const snapshot = { version: 1, epoch: 1, revision: 1 } as unknown as GlanceSnapshotV1

/** Capture the handler passed to the next `listen` call. */
function captureListener() {
  const unlisten = jest.fn()
  let handler: ((event: { payload: unknown }) => void) | undefined
  listenMock.mockImplementation(
    async (_event: string, cb: (event: { payload: unknown }) => void) => {
      handler = cb
      return unlisten
    }
  )
  return { unlisten, fire: (payload: unknown) => handler?.({ payload }) }
}

beforeEach(() => {
  emitToMock.mockReset().mockResolvedValue(undefined)
  listenMock.mockReset().mockResolvedValue(() => {})
  isTauriMock.mockReset().mockReturnValue(true)
  warnMock.mockReset()
})

describe("channel constants", () => {
  it("pins the event names and main window label", () => {
    expect(GLANCE_MAIN_WINDOW_LABEL).toBe("main")
    expect(GLANCE_SUBSCRIBE_EVENT).toBe("glance://subscribe")
    expect(GLANCE_SNAPSHOT_EVENT).toBe("glance://snapshot")
    expect(GLANCE_REQUEST_EVENT).toBe("glance://request")
    expect(GLANCE_RESULT_EVENT).toBe("glance://result")
  })

  it("renews well inside the TTL so one missed beat does not drop the lease", () => {
    expect(GLANCE_LEASE_RENEW_MS).toBeLessThan(GLANCE_LEASE_TTL_MS)
    expect(GLANCE_LEASE_TTL_MS / GLANCE_LEASE_RENEW_MS).toBeGreaterThanOrEqual(2)
  })
})

describe("isGlanceSubscription", () => {
  it("accepts a well-formed subscription", () => {
    expect(isGlanceSubscription(subscription)).toBe(true)
    expect(isGlanceSubscription({ ...subscription, visible: false })).toBe(true)
  })

  it("accepts ids at the 64-character limit and rejects beyond it", () => {
    expect(isGlanceSubscription({ ...subscription, consumer: "c".repeat(64) })).toBe(true)
    expect(isGlanceSubscription({ ...subscription, consumer: "c".repeat(65) })).toBe(false)
    expect(isGlanceSubscription({ ...subscription, windowLabel: "w".repeat(64) })).toBe(true)
    expect(isGlanceSubscription({ ...subscription, windowLabel: "w".repeat(65) })).toBe(false)
  })

  it.each([[null], [undefined], ["x"], [1], [true]])("rejects non-object %j", (value) => {
    expect(isGlanceSubscription(value)).toBe(false)
  })

  it.each([
    ["empty consumer", { consumer: "" }],
    ["numeric consumer", { consumer: 1 }],
    ["missing consumer", { consumer: undefined }],
    ["empty windowLabel", { windowLabel: "" }],
    ["numeric windowLabel", { windowLabel: 2 }],
    ["missing windowLabel", { windowLabel: undefined }],
    ["string visible", { visible: "true" }],
    ["numeric visible", { visible: 1 }],
    ["missing visible", { visible: undefined }],
  ])("rejects %s", (_name, patch) => {
    expect(isGlanceSubscription({ ...subscription, ...patch })).toBe(false)
  })
})

describe("senders", () => {
  it("sendGlanceSubscription emits to the main window", async () => {
    await expect(sendGlanceSubscription(subscription)).resolves.toBe(true)
    expect(emitToMock).toHaveBeenCalledWith("main", "glance://subscribe", subscription)
  })

  it("sendGlanceRequest emits to the main window", async () => {
    await expect(sendGlanceRequest(request)).resolves.toBe(true)
    expect(emitToMock).toHaveBeenCalledWith("main", "glance://request", request)
  })

  it("sendGlanceSnapshot emits to the named consumer window only", async () => {
    await expect(sendGlanceSnapshot("tray-panel", snapshot)).resolves.toBe(true)
    expect(emitToMock).toHaveBeenCalledTimes(1)
    expect(emitToMock).toHaveBeenCalledWith("tray-panel", "glance://snapshot", snapshot)
  })

  it("sendGlanceResult emits to the named consumer window", async () => {
    await expect(sendGlanceResult("tray-panel", result)).resolves.toBe(true)
    expect(emitToMock).toHaveBeenCalledWith("tray-panel", "glance://result", result)
  })

  it("never broadcasts: every emit is addressed", async () => {
    await sendGlanceSubscription(subscription)
    await sendGlanceRequest(request)
    await sendGlanceSnapshot("w", snapshot)
    await sendGlanceResult("w", result)
    for (const call of emitToMock.mock.calls) {
      expect(typeof call[0]).toBe("string")
      expect(call[0].length).toBeGreaterThan(0)
    }
  })

  it.each([
    ["sendGlanceSubscription", () => sendGlanceSubscription(subscription)],
    ["sendGlanceRequest", () => sendGlanceRequest(request)],
    ["sendGlanceSnapshot", () => sendGlanceSnapshot("w", snapshot)],
    ["sendGlanceResult", () => sendGlanceResult("w", result)],
  ])("%s returns false when the emit fails (a closed window is normal)", async (_name, send) => {
    emitToMock.mockRejectedValue(new Error("window not found"))
    await expect(send()).resolves.toBe(false)
  })

  it("logs a failed subscription or request emit but stays quiet for a closed consumer window", async () => {
    emitToMock.mockRejectedValue(new Error("window not found"))
    await sendGlanceSubscription(subscription)
    await sendGlanceRequest(request)
    expect(warnMock).toHaveBeenCalledTimes(2)
    await sendGlanceSnapshot("w", snapshot)
    await sendGlanceResult("w", result)
    expect(warnMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["sendGlanceSubscription", () => sendGlanceSubscription(subscription)],
    ["sendGlanceRequest", () => sendGlanceRequest(request)],
    ["sendGlanceSnapshot", () => sendGlanceSnapshot("w", snapshot)],
    ["sendGlanceResult", () => sendGlanceResult("w", result)],
  ])("%s returns false off Tauri without emitting", async (_name, send) => {
    isTauriMock.mockReturnValue(false)
    await expect(send()).resolves.toBe(false)
    expect(emitToMock).not.toHaveBeenCalled()
  })
})

describe("listeners", () => {
  it.each([
    ["onGlanceSubscription", onGlanceSubscription, "glance://subscribe"],
    ["onGlanceSnapshot", onGlanceSnapshot, "glance://snapshot"],
    ["onGlanceRequest", onGlanceRequest, "glance://request"],
    ["onGlanceResult", onGlanceResult, "glance://result"],
  ] as Array<[string, (h: () => void) => Promise<() => void>, string]>)(
    "%s listens on %s",
    async (_name, on, event) => {
      await on(() => {})
      expect(listenMock).toHaveBeenCalledWith(event, expect.any(Function))
    }
  )

  it.each([
    ["onGlanceSubscription", onGlanceSubscription],
    ["onGlanceSnapshot", onGlanceSnapshot],
    ["onGlanceRequest", onGlanceRequest],
    ["onGlanceResult", onGlanceResult],
  ] as Array<[string, (h: () => void) => Promise<() => void>]>)(
    "%s is a no-op off Tauri with a callable unsubscribe",
    async (_name, on) => {
      isTauriMock.mockReturnValue(false)
      const off = await on(() => {})
      expect(typeof off).toBe("function")
      expect(() => off()).not.toThrow()
      expect(listenMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["onGlanceSubscription", onGlanceSubscription],
    ["onGlanceSnapshot", onGlanceSnapshot],
    ["onGlanceRequest", onGlanceRequest],
    ["onGlanceResult", onGlanceResult],
  ] as Array<[string, (h: () => void) => Promise<() => void>]>)(
    "%s's unsubscribe calls the underlying unlisten",
    async (_name, on) => {
      const { unlisten } = captureListener()
      const off = await on(() => {})
      off()
      expect(unlisten).toHaveBeenCalledTimes(1)
    }
  )

  it("an unsubscribe whose unlisten throws is swallowed", async () => {
    listenMock.mockResolvedValue(() => {
      throw new Error("already gone")
    })
    const off = await onGlanceSnapshot(() => {})
    expect(() => off()).not.toThrow()
  })

  describe("onGlanceSubscription", () => {
    it("delivers valid subscriptions", async () => {
      const { fire } = captureListener()
      const handler = jest.fn()
      await onGlanceSubscription(handler)
      fire(subscription)
      expect(handler).toHaveBeenCalledWith(subscription)
    })

    it.each([
      [null],
      ["x"],
      [{}],
      [{ consumer: "", windowLabel: "w", visible: true }],
      [{ consumer: "c", windowLabel: "w".repeat(65), visible: true }],
      [{ consumer: "c", windowLabel: "w", visible: "yes" }],
    ])("ignores invalid payload %j", async (payload) => {
      const { fire } = captureListener()
      const handler = jest.fn()
      await onGlanceSubscription(handler)
      fire(payload)
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe("pass-through listeners", () => {
    it("onGlanceSnapshot hands the raw payload to the caller for validation", async () => {
      const { fire } = captureListener()
      const handler = jest.fn()
      await onGlanceSnapshot(handler)
      fire("not a snapshot")
      expect(handler).toHaveBeenCalledWith("not a snapshot")
    })

    it("onGlanceRequest hands the raw payload to the caller for validation", async () => {
      const { fire } = captureListener()
      const handler = jest.fn()
      await onGlanceRequest(handler)
      fire({ anything: 1 })
      expect(handler).toHaveBeenCalledWith({ anything: 1 })
    })

    it("onGlanceResult delivers the result payload", async () => {
      const { fire } = captureListener()
      const handler = jest.fn()
      await onGlanceResult(handler)
      fire(result)
      expect(handler).toHaveBeenCalledWith(result)
    })
  })
})
