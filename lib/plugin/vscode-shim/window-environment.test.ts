/**
 * @jest-environment jsdom
 */

type Handler = (payload: unknown, context: { pluginId: string }) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockLog = jest.fn()
jest.mock("./vscode-log-buffer", () => ({
  appendVscodeLog: (...args: unknown[]) => mockLog(...args),
}))

import {
  configureVscodeWindowEnvironment,
  installVscodeWindowEnvironmentHandlers,
  readWindowEnvironment,
  WINDOW_INACTIVE_AFTER_MS,
} from "./window-environment"

describe("window environment", () => {
  let hasFocus: jest.SpyInstance<boolean, []>
  let sendToHost: jest.Mock
  let dispose: Array<() => void>

  const describe_ = () => handlers.get("window:describeEnvironment")!({}, { pluginId: "a.b" })
  const pushed = () => sendToHost.mock.calls.map((call) => call[2])
  // Mutation records and rejected sends settle on microtasks, which fake timers leave alone.
  const flush = async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "queueMicrotask"] })
    jest.setSystemTime(new Date("2026-10-03T00:00:00Z"))
    hasFocus = jest.spyOn(document, "hasFocus").mockReturnValue(true)
    document.documentElement.classList.remove("dark")
    sendToHost = jest.fn(async () => null)
    mockLog.mockClear()
    dispose = installVscodeWindowEnvironmentHandlers()
  })

  afterEach(() => {
    configureVscodeWindowEnvironment(null)
    dispose.forEach((fn) => fn())
    hasFocus.mockRestore()
    jest.useRealTimers()
  })

  const configure = (hosts = ["a.b", "c.d"]) =>
    configureVscodeWindowEnvironment({ sendToHost, hosts: () => hosts })

  it("reads focus and the dark class", () => {
    expect(readWindowEnvironment(window)).toEqual({
      focused: true,
      active: true,
      colorThemeKind: 1,
    })
    document.documentElement.classList.add("dark")
    hasFocus.mockReturnValue(false)
    expect(readWindowEnvironment(window)).toEqual({
      focused: false,
      active: false,
      colorThemeKind: 2,
    })
  })

  it("answers describeEnvironment before and after it is configured", () => {
    expect(describe_()).toEqual({ focused: true, active: true, colorThemeKind: 1 })
    configure()
    window.dispatchEvent(new Event("blur"))
    expect(describe_()).toEqual({ focused: false, active: true, colorThemeKind: 1 })
  })

  it("tells every host when focus changes, and only when it changes", () => {
    configure()
    window.dispatchEvent(new Event("blur"))
    window.dispatchEvent(new Event("blur"))
    expect(sendToHost.mock.calls).toEqual([
      ["a.b", "window:environmentChanged", { focused: false, active: true, colorThemeKind: 1 }],
      ["c.d", "window:environmentChanged", { focused: false, active: true, colorThemeKind: 1 }],
    ])
  })

  it("goes inactive after the idle time and active again on input", () => {
    configure(["a.b"])
    jest.advanceTimersByTime(WINDOW_INACTIVE_AFTER_MS)
    expect(pushed()).toEqual([{ focused: true, active: false, colorThemeKind: 1 }])
    window.dispatchEvent(new KeyboardEvent("keydown"))
    expect(pushed().at(-1)).toEqual({ focused: true, active: true, colorThemeKind: 1 })
  })

  it("restarts the idle time on activity, at most once a second", () => {
    configure(["a.b"])
    jest.advanceTimersByTime(WINDOW_INACTIVE_AFTER_MS - 2_000)
    window.dispatchEvent(new Event("pointerdown"))
    jest.advanceTimersByTime(WINDOW_INACTIVE_AFTER_MS - 1)
    expect(pushed()).toEqual([])
    jest.advanceTimersByTime(1)
    expect(pushed()).toEqual([{ focused: true, active: false, colorThemeKind: 1 }])
  })

  it("is inactive while hidden", () => {
    configure(["a.b"])
    const visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    expect(pushed()).toEqual([{ focused: true, active: false, colorThemeKind: 1 }])
    visibility.mockReturnValue("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    expect(pushed().at(-1)?.active).toBe(true)
    visibility.mockRestore()
  })

  it("follows the theme", async () => {
    configure(["a.b"])
    document.documentElement.classList.add("dark")
    await flush()
    expect(pushed()).toEqual([{ focused: true, active: true, colorThemeKind: 2 }])
  })

  it("logs a host it could not tell", async () => {
    sendToHost.mockRejectedValue(new Error("host gone"))
    configure(["a.b"])
    window.dispatchEvent(new Event("blur"))
    await flush()
    expect(mockLog).toHaveBeenCalledWith("a.b", {
      level: "warn",
      kind: "window",
      message: "Could not tell the extension the window's focus or theme changed: host gone",
    })
  })

  it("stops listening when unconfigured", () => {
    configure(["a.b"])
    configureVscodeWindowEnvironment(null)
    window.dispatchEvent(new Event("blur"))
    jest.advanceTimersByTime(WINDOW_INACTIVE_AFTER_MS)
    expect(sendToHost).not.toHaveBeenCalled()
  })
})
