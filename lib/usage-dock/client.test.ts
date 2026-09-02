/** @jest-environment jsdom */
// The Tauri client. What matters is that every call is inert outside Tauri, so
// the browser and mobile shells import this module without a guard at each
// call site and the dock simply does not exist there.

const invokeMock = jest.fn()
const emitToMock = jest.fn()
const listenMock = jest.fn(async () => () => {})
let tauri = false

jest.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }))
jest.mock("@tauri-apps/api/event", () => ({
  emitTo: (...a: unknown[]) => emitToMock(...a),
  listen: (...a: unknown[]) => listenMock(...(a as [])),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

import {
  closeUsageDock,
  isUsageDockOpen,
  listUsageDockMonitors,
  MAIN_WINDOW_LABEL,
  onUsageDockHover,
  onUsageDockState,
  openUsageDock,
  requestUsageDockOpenFull,
  requestUsageDockState,
  resizeUsageDock,
  revealUsageDock,
  sendUsageDockState,
  setUsageDockClickThrough,
  setUsageDockPlacement,
  setUsageDockScale,
  snapUsageDock,
  usageDockCapabilities,
  USAGE_DOCK_STATE_EVENT,
  USAGE_DOCK_WINDOW_LABEL,
} from "./client"
import { DEFAULT_USAGE_DOCK_PREFERENCES } from "./types"

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined)
  emitToMock.mockReset().mockResolvedValue(undefined)
  listenMock.mockClear()
  tauri = true
})

describe("outside Tauri", () => {
  beforeEach(() => {
    tauri = false
  })

  it("performs no IPC at all", async () => {
    await openUsageDock()
    await closeUsageDock()
    await revealUsageDock()
    await resizeUsageDock(10, 10)
    await setUsageDockClickThrough(true)
    await setUsageDockPlacement("left")
    await setUsageDockMonitorSafely()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(emitToMock).not.toHaveBeenCalled()
  })

  it("reports the dock closed and unsupported rather than throwing", async () => {
    expect(await isUsageDockOpen()).toBe(false)
    expect(await listUsageDockMonitors()).toEqual([])
    expect(await snapUsageDock(1, 2)).toBeNull()
    expect(
      await sendUsageDockState({ glance: null, preferences: DEFAULT_USAGE_DOCK_PREFERENCES })
    ).toBe(false)
    expect(await requestUsageDockState()).toBe(false)
    expect(await requestUsageDockOpenFull()).toBe(false)
  })

  it("reports a blocked capability report, not a null the caller must branch on", async () => {
    const caps = await usageDockCapabilities()
    expect(caps.positioning).toBe(false)
    expect(caps.blockedReason).toBe("notDesktop")
    expect(caps.platform).toBe("web")
  })

  it("returns a no-op disposer from every subscription", async () => {
    const off = await onUsageDockState(() => {})
    const offHover = await onUsageDockHover(() => {})
    expect(() => off()).not.toThrow()
    expect(() => offHover()).not.toThrow()
    expect(listenMock).not.toHaveBeenCalled()
  })
})

async function setUsageDockMonitorSafely() {
  const { setUsageDockMonitor } = await import("./client")
  await setUsageDockMonitor(null)
}

describe("inside Tauri", () => {
  it("invokes the native commands", async () => {
    await openUsageDock()
    expect(invokeMock).toHaveBeenCalledWith("usage_dock_open", undefined)
    await resizeUsageDock(100, 200)
    expect(invokeMock).toHaveBeenCalledWith("usage_dock_resize", { width: 100, height: 200 })
    await setUsageDockClickThrough(true)
    expect(invokeMock).toHaveBeenCalledWith("usage_dock_set_click_through", { ignore: true })
  })

  it("swallows a failing command rather than breaking the caller", async () => {
    invokeMock.mockRejectedValue(new Error("no such window"))
    await expect(openUsageDock()).resolves.toBeUndefined()
    expect(await isUsageDockOpen()).toBe(false)
    expect(await snapUsageDock(1, 2)).toBeNull()
  })

  it("clamps a scale through the native command and returns what landed", async () => {
    invokeMock.mockResolvedValue(1.2)
    expect(await setUsageDockScale(99)).toBe(1.2)
    expect(invokeMock).toHaveBeenCalledWith("usage_dock_set_scale", { scale: 99 })
  })

  it("pushes state to the dock window by label", async () => {
    await sendUsageDockState({ glance: null, preferences: DEFAULT_USAGE_DOCK_PREFERENCES })
    expect(emitToMock).toHaveBeenCalledWith(
      USAGE_DOCK_WINDOW_LABEL,
      USAGE_DOCK_STATE_EVENT,
      expect.objectContaining({ glance: null })
    )
  })

  it("reports a closed dock as a normal outcome, not an error", async () => {
    emitToMock.mockRejectedValue(new Error("no window"))
    expect(
      await sendUsageDockState({ glance: null, preferences: DEFAULT_USAGE_DOCK_PREFERENCES })
    ).toBe(false)
  })

  it("routes the dock's requests back to the main window", async () => {
    await requestUsageDockState()
    expect(emitToMock).toHaveBeenCalledWith(MAIN_WINDOW_LABEL, expect.any(String), null)
  })

  it("falls back to a blocked report when the native probe fails", async () => {
    invokeMock.mockRejectedValue(new Error("nope"))
    expect((await usageDockCapabilities()).blockedReason).toBe("notDesktop")
  })
})
