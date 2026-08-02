jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@tauri-apps/api/event", () => ({ emitTo: jest.fn(), listen: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

import { invoke } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"

import {
  DEFAULT_TRAY_PANEL_CONFIG,
  MAIN_WINDOW_LABEL,
  TRAY_PANEL_RESULT_EVENT,
  TRAY_PANEL_RUN_EVENT,
  TRAY_PANEL_STATE_EVENT,
  TRAY_PANEL_STATE_REQUEST_EVENT,
  TRAY_PANEL_WINDOW_LABEL,
  closeTrayPanel,
  getTrayPanelConfig,
  onTrayPanelRequest,
  onTrayPanelResult,
  onTrayPanelState,
  onTrayPanelStateRequest,
  onTrayPanelVisibility,
  openTrayPanel,
  requestTrayPanelState,
  resizeTrayPanel,
  revealTrayPanel,
  runNativeTrayAction,
  sendTrayPanelRequest,
  sendTrayPanelResult,
  sendTrayPanelState,
  setTrayLeftClickAction,
  toggleTrayPanel,
} from "./tray-panel"
import type { TrayPanelRunRequest } from "@/lib/tray-panel/types"

const invokeMock = invoke as jest.Mock
const emitToMock = emitTo as jest.Mock
const listenMock = listen as jest.Mock
const isTauriMock = isTauri as jest.Mock

const request: TrayPanelRunRequest = {
  requestId: "r1",
  actionId: "a",
  actionLabel: "A",
  effect: { kind: "navigate", path: "/x" },
  focusMainWindow: true,
}

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined)
  emitToMock.mockReset().mockResolvedValue(undefined)
  listenMock.mockReset().mockResolvedValue(() => {})
  isTauriMock.mockReset().mockReturnValue(true)
})

describe("labels and channels", () => {
  it("pins the window labels the Rust side uses", () => {
    expect(TRAY_PANEL_WINDOW_LABEL).toBe("tray-panel")
    expect(MAIN_WINDOW_LABEL).toBe("main")
  })

  it("mirrors the Rust config defaults", () => {
    expect(DEFAULT_TRAY_PANEL_CONFIG).toEqual({ leftClick: "panel", width: 380, height: 460 })
  })
})

describe("window commands", () => {
  it.each([
    ["openTrayPanel", "open_tray_panel", openTrayPanel],
    ["closeTrayPanel", "close_tray_panel", closeTrayPanel],
    ["toggleTrayPanel", "toggle_tray_panel", toggleTrayPanel],
  ])("%s invokes %s", async (_name, command, fn) => {
    await expect((fn as () => Promise<boolean>)()).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith(command)
  })

  it("passes the reveal focus flag through", async () => {
    await revealTrayPanel(true)
    expect(invokeMock).toHaveBeenCalledWith("reveal_tray_panel", { focus: true })
  })

  it("passes measured dimensions through", async () => {
    await resizeTrayPanel(380, 512)
    expect(invokeMock).toHaveBeenCalledWith("tray_panel_resize", { width: 380, height: 512 })
  })

  it("persists the left-click preference", async () => {
    await setTrayLeftClickAction("toggle-window")
    expect(invokeMock).toHaveBeenCalledWith("tray_panel_set_left_click", {
      action: "toggle-window",
    })
  })

  it("runs a native action straight through Rust", async () => {
    await expect(runNativeTrayAction("show")).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("tray_run_native_action", { action: "show" })
  })

  it("swallows a command failure rather than breaking the panel", async () => {
    invokeMock.mockRejectedValue(new Error("no window"))
    await expect(closeTrayPanel()).resolves.toBe(false)
    await expect(runNativeTrayAction("show")).resolves.toBe(false)
  })

  it("no-ops off Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    await expect(openTrayPanel()).resolves.toBe(false)
    await expect(revealTrayPanel(true)).resolves.toBe(false)
    await expect(resizeTrayPanel(1, 1)).resolves.toBe(false)
    await expect(setTrayLeftClickAction("none")).resolves.toBe(false)
    await expect(runNativeTrayAction("show")).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe("getTrayPanelConfig", () => {
  it("returns what Rust reports", async () => {
    invokeMock.mockResolvedValue({ leftClick: "none", width: 400, height: 500 })
    await expect(getTrayPanelConfig()).resolves.toEqual({
      leftClick: "none",
      width: 400,
      height: 500,
    })
  })

  it("falls back to the defaults on failure and off Tauri", async () => {
    invokeMock.mockRejectedValue(new Error("nope"))
    await expect(getTrayPanelConfig()).resolves.toEqual(DEFAULT_TRAY_PANEL_CONFIG)
    isTauriMock.mockReturnValue(false)
    await expect(getTrayPanelConfig()).resolves.toEqual(DEFAULT_TRAY_PANEL_CONFIG)
  })
})

describe("cross-window messaging", () => {
  it("addresses run requests to the main window only", async () => {
    // A broadcast would run the request once per open window — and the pet
    // overlay, popup and island all load the same root layout.
    await expect(sendTrayPanelRequest(request)).resolves.toBe(true)
    expect(emitToMock).toHaveBeenCalledWith(MAIN_WINDOW_LABEL, TRAY_PANEL_RUN_EVENT, request)
  })

  it("addresses results back to the panel window", async () => {
    await sendTrayPanelResult({ requestId: "r1", ok: true })
    expect(emitToMock).toHaveBeenCalledWith(TRAY_PANEL_WINDOW_LABEL, TRAY_PANEL_RESULT_EVENT, {
      requestId: "r1",
      ok: true,
    })
  })

  it("treats a result emitted to a closed panel as expected, not an error", async () => {
    emitToMock.mockRejectedValue(new Error("window not found"))
    await expect(sendTrayPanelResult({ requestId: "r", ok: false })).resolves.toBe(false)
    await expect(sendTrayPanelState({})).resolves.toBe(false)
  })

  it("reports a failed request delivery so the panel can say so", async () => {
    emitToMock.mockRejectedValue(new Error("boom"))
    await expect(sendTrayPanelRequest(request)).resolves.toBe(false)
  })

  it("routes state requests and pushes over their own channels", async () => {
    await requestTrayPanelState()
    expect(emitToMock).toHaveBeenCalledWith(MAIN_WINDOW_LABEL, TRAY_PANEL_STATE_REQUEST_EVENT, null)
    await sendTrayPanelState({ platform: { os: "macos" } })
    expect(emitToMock).toHaveBeenCalledWith(TRAY_PANEL_WINDOW_LABEL, TRAY_PANEL_STATE_EVENT, {
      platform: { os: "macos" },
    })
  })

  it("reports a failed state request", async () => {
    emitToMock.mockRejectedValue(new Error("boom"))
    await expect(requestTrayPanelState()).resolves.toBe(false)
  })
})

describe("subscriptions", () => {
  it("unwraps the payload for each listener", async () => {
    const seen: unknown[] = []
    listenMock.mockImplementation((_name: string, handler: (e: { payload: unknown }) => void) => {
      handler({ payload: "payload" })
      return Promise.resolve(() => {})
    })

    await onTrayPanelRequest((r) => seen.push(r))
    await onTrayPanelResult((r) => seen.push(r))
    await onTrayPanelState((s) => seen.push(s))
    expect(seen).toEqual(["payload", "payload", "payload"])
  })

  it("fires the state-request handler with no payload", async () => {
    const handler = jest.fn()
    listenMock.mockImplementation((_name: string, cb: (e: unknown) => void) => {
      cb({ payload: null })
      return Promise.resolve(() => {})
    })
    await onTrayPanelStateRequest(handler)
    expect(handler).toHaveBeenCalledWith()
  })

  it("maps the two visibility channels to a boolean", async () => {
    const calls: boolean[] = []
    listenMock.mockImplementation((name: string, cb: (e: unknown) => void) => {
      cb({ payload: null })
      return Promise.resolve(() => {
        calls.push(name.endsWith("shown"))
      })
    })
    const dispose = await onTrayPanelVisibility((visible) => calls.push(visible))
    expect(calls).toEqual([false, true])
    // Disposing must detach BOTH listeners, not just the first.
    dispose()
    expect(calls).toHaveLength(4)
  })

  it("returns a no-op unsubscribe off Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const handler = jest.fn()
    for (const subscribe of [
      onTrayPanelRequest,
      onTrayPanelResult,
      onTrayPanelState,
      onTrayPanelStateRequest,
      onTrayPanelVisibility,
    ]) {
      const dispose = await (subscribe as (h: unknown) => Promise<() => void>)(handler)
      expect(typeof dispose).toBe("function")
      dispose()
    }
    expect(listenMock).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })
})
