import { act, renderHook } from "@testing-library/react"

import { useTerminalChrome, type TerminalChromeOptions } from "./use-terminal-chrome"
import * as screenMod from "../../screen"
import * as titleMod from "../../terminal-title"
import * as notifyMod from "../../notify"
import type { ScreenStream } from "../../screen"
import type { TitleStream } from "../../terminal-title"

jest.mock("../../screen", () => ({
  enterAltScreen: jest.fn(),
  exitAltScreen: jest.fn(),
  applyMouseMode: jest.fn(),
  resetMouse: jest.fn(),
}))
jest.mock("../../terminal-title", () => ({
  applyTerminalTitle: jest.fn(),
  resetTerminalTitle: jest.fn(),
  computeTitle: jest.fn(() => "TITLE"),
}))
jest.mock("../../notify", () => ({
  emitCompletionBell: jest.fn(),
  shouldNotifyOnDone: jest.fn(() => true),
}))

const screen = { write: jest.fn() } as unknown as ScreenStream
const titleSink = { write: jest.fn() } as unknown as TitleStream

function baseOpts(over: Partial<TerminalChromeOptions> = {}): TerminalChromeOptions {
  return {
    fullscreen: true,
    screen,
    mouseMode: "scroll",
    altScreenPreEntered: false,
    stdout: undefined,
    clearScreen: jest.fn(),
    dispatch: jest.fn(),
    titleEnabled: true,
    titleSink,
    titleEnv: undefined,
    busy: false,
    awaitingInput: false,
    activityKind: undefined,
    cwd: "/repo/project",
    notifyEnabled: false,
    now: () => 0,
    ...over,
  }
}

describe("useTerminalChrome — alt screen", () => {
  afterEach(() => jest.clearAllMocks())

  it("enters the alt screen + applies the mouse mode on mount, restores on unmount", () => {
    const { unmount } = renderHook(() => useTerminalChrome(baseOpts()))
    expect(screenMod.enterAltScreen).toHaveBeenCalledWith(screen)
    expect(screenMod.applyMouseMode).toHaveBeenCalledWith("scroll", screen)
    unmount()
    expect(screenMod.resetMouse).toHaveBeenCalledWith(screen)
    expect(screenMod.exitAltScreen).toHaveBeenCalledWith(screen)
  })

  it("skips the enter when mount.tsx pre-entered the alt screen", () => {
    renderHook(() => useTerminalChrome(baseOpts({ altScreenPreEntered: true })))
    expect(screenMod.enterAltScreen).not.toHaveBeenCalled()
  })

  it("does nothing in scrollback (non-fullscreen) mode", () => {
    renderHook(() => useTerminalChrome(baseOpts({ fullscreen: false })))
    expect(screenMod.enterAltScreen).not.toHaveBeenCalled()
  })
})

describe("useTerminalChrome — title", () => {
  afterEach(() => jest.clearAllMocks())

  it("applies the computed title and restores the default on unmount", () => {
    const { unmount } = renderHook(() => useTerminalChrome(baseOpts()))
    expect(titleMod.applyTerminalTitle).toHaveBeenCalledWith("TITLE", titleSink, undefined)
    unmount()
    expect(titleMod.resetTerminalTitle).toHaveBeenCalledWith(titleSink, undefined)
  })

  it("never writes the title when disabled", () => {
    const { unmount } = renderHook(() => useTerminalChrome(baseOpts({ titleEnabled: false })))
    expect(titleMod.applyTerminalTitle).not.toHaveBeenCalled()
    unmount()
    expect(titleMod.resetTerminalTitle).not.toHaveBeenCalled()
  })

  it("passes the project basename, busy + activity to computeTitle", () => {
    renderHook(() =>
      useTerminalChrome(baseOpts({ busy: true, activityKind: "goal", cwd: "/a/b/myproj" }))
    )
    expect(titleMod.computeTitle).toHaveBeenCalledWith({
      busy: true,
      awaitingInput: false,
      activity: "goal",
      dir: "myproj",
    })
  })
})

describe("useTerminalChrome — completion bell", () => {
  afterEach(() => jest.clearAllMocks())

  it("rings the bell on a busy→idle transition when the gate passes", () => {
    const now = jest.fn().mockReturnValueOnce(1000).mockReturnValueOnce(6000)
    const { rerender } = renderHook((p: TerminalChromeOptions) => useTerminalChrome(p), {
      initialProps: baseOpts({ busy: true, notifyEnabled: true, now }),
    })
    rerender(baseOpts({ busy: false, notifyEnabled: true, now }))
    expect(notifyMod.shouldNotifyOnDone).toHaveBeenCalledWith(true, 5000)
    expect(notifyMod.emitCompletionBell).toHaveBeenCalledWith(titleSink, undefined)
  })

  it("does not ring on the busy→idle transition when the gate fails", () => {
    ;(notifyMod.shouldNotifyOnDone as jest.Mock).mockReturnValueOnce(false)
    const { rerender } = renderHook((p: TerminalChromeOptions) => useTerminalChrome(p), {
      initialProps: baseOpts({ busy: true, notifyEnabled: true }),
    })
    rerender(baseOpts({ busy: false, notifyEnabled: true }))
    expect(notifyMod.emitCompletionBell).not.toHaveBeenCalled()
  })
})

describe("useTerminalChrome — resize repaint", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  it("debounces a scrollback resize into a clear + REPAINT", () => {
    const handlers: Array<() => void> = []
    const stdout = {
      on: (_e: "resize", cb: () => void) => handlers.push(cb),
      off: jest.fn(),
    }
    const clearScreen = jest.fn()
    const dispatch = jest.fn()
    renderHook(() =>
      useTerminalChrome(baseOpts({ fullscreen: false, stdout, clearScreen, dispatch }))
    )
    expect(handlers).toHaveLength(1)
    act(() => {
      handlers[0]()
      jest.advanceTimersByTime(120)
    })
    expect(clearScreen).toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledWith({ type: "REPAINT" })
  })

  it("registers no resize listener in fullscreen mode", () => {
    const on = jest.fn()
    renderHook(() =>
      useTerminalChrome(baseOpts({ fullscreen: true, stdout: { on, off: jest.fn() } }))
    )
    expect(on).not.toHaveBeenCalled()
  })
})
