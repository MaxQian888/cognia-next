/**
 * @jest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react"

const logWarn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      warn: (...args: unknown[]) => logWarn(...args),
      info: jest.fn(),
      error: jest.fn(),
    },
  },
}))

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const show = jest.fn().mockResolvedValue(undefined)
const setFocus = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show, setFocus }),
}))

const invoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

import { __resetHostModeForTests } from "@/lib/tauri/host-mode"
import { WindowShowInitializer } from "./window-show-initializer"

/** Answer `host_mode_get` with `bootHidden`, every other command with `rest`. */
function routeInvoke(bootHidden: boolean, rest: (cmd: string) => Promise<unknown>) {
  invoke.mockImplementation((cmd: string) =>
    cmd === "host_mode_get" ? Promise.resolve({ enabled: bootHidden, bootHidden }) : rest(cmd)
  )
}

/**
 * Run queued requestAnimationFrame callbacks synchronously so the two-frame
 * defer in the component resolves within the test without real timers.
 */
function flushRaf() {
  let original: typeof requestAnimationFrame
  const queue: FrameRequestCallback[] = []
  return {
    install() {
      original = window.requestAnimationFrame
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        queue.push(cb)
        return queue.length
      }) as typeof requestAnimationFrame
      window.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
    },
    drain() {
      // Drain repeatedly so a callback that schedules another frame runs too.
      while (queue.length) {
        const cb = queue.shift()!
        cb(performance.now())
      }
    },
    restore() {
      window.requestAnimationFrame = original
    },
  }
}

let raf: ReturnType<typeof flushRaf>

beforeEach(() => {
  logWarn.mockReset()
  isTauriMock.mockReset()
  show.mockReset().mockResolvedValue(undefined)
  setFocus.mockReset().mockResolvedValue(undefined)
  invoke.mockReset()
  routeInvoke(false, () => Promise.resolve(undefined))
  __resetHostModeForTests()
  raf = flushRaf()
  raf.install()
})

afterEach(() => {
  raf.restore()
})

test("web mode never shows the window", () => {
  isTauriMock.mockReturnValue(false)
  const { container } = render(<WindowShowInitializer />)
  raf.drain()
  expect(container).toBeEmptyDOMElement()
  expect(show).not.toHaveBeenCalled()
})

test("Tauri mode reveals and focuses the window after two frames", async () => {
  isTauriMock.mockReturnValue(true)
  render(<WindowShowInitializer />)
  raf.drain()
  await waitFor(() => expect(show).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("webview_acknowledge_boot_reveal"))
  await waitFor(() => expect(setFocus).toHaveBeenCalledTimes(1))
})

test("does not reveal when unmounted before the frames fire", async () => {
  isTauriMock.mockReturnValue(true)
  const { unmount } = render(<WindowShowInitializer />)
  unmount()
  raf.drain()
  // Give any in-flight microtasks a chance to (not) run.
  await Promise.resolve()
  expect(show).not.toHaveBeenCalled()
})

test("logs a warning when show() rejects with an Error", async () => {
  isTauriMock.mockReturnValue(true)
  show.mockRejectedValueOnce(new Error("boom"))
  render(<WindowShowInitializer />)
  raf.drain()
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "window-show: failed to reveal main window",
      expect.objectContaining({ error: "boom" })
    )
  )
  expect(invoke).not.toHaveBeenCalledWith("webview_acknowledge_boot_reveal")
})

test("a hidden login launch in host mode never reveals the window", async () => {
  isTauriMock.mockReturnValue(true)
  routeInvoke(true, () => Promise.resolve(undefined))
  render(<WindowShowInitializer />)
  raf.drain()
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("host_mode_get"))
  await Promise.resolve()
  await Promise.resolve()
  expect(show).not.toHaveBeenCalled()
  expect(setFocus).not.toHaveBeenCalled()
})

test("reveals the window when host mode cannot be read", async () => {
  isTauriMock.mockReturnValue(true)
  invoke.mockImplementation((cmd: string) =>
    cmd === "host_mode_get" ? Promise.reject(new Error("no command")) : Promise.resolve(undefined)
  )
  render(<WindowShowInitializer />)
  raf.drain()
  await waitFor(() => expect(show).toHaveBeenCalledTimes(1))
})

test("warning falls back to String(err) for non-Error throws", async () => {
  isTauriMock.mockReturnValue(true)
  show.mockRejectedValueOnce("string-err")
  render(<WindowShowInitializer />)
  raf.drain()
  await waitFor(() =>
    expect(logWarn).toHaveBeenCalledWith(
      "window-show: failed to reveal main window",
      expect.objectContaining({ error: "string-err" })
    )
  )
})

test("focuses the shown window when boot-reveal acknowledgement fails", async () => {
  isTauriMock.mockReturnValue(true)
  routeInvoke(false, () => Promise.reject(new Error("ack failed")))
  render(<WindowShowInitializer />)
  raf.drain()

  await waitFor(() => expect(setFocus).toHaveBeenCalledTimes(1))
  expect(logWarn).toHaveBeenCalledWith(
    "window-show: failed to acknowledge boot reveal",
    expect.objectContaining({ error: "ack failed" })
  )
})

test("stringifies a non-Error boot-reveal acknowledgement failure", async () => {
  isTauriMock.mockReturnValue(true)
  routeInvoke(false, () => Promise.reject("ack string failure"))
  render(<WindowShowInitializer />)
  raf.drain()

  await waitFor(() => expect(setFocus).toHaveBeenCalledTimes(1))
  expect(logWarn).toHaveBeenCalledWith(
    "window-show: failed to acknowledge boot reveal",
    expect.objectContaining({ error: "ack string failure" })
  )
})
