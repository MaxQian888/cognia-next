/**
 * @jest-environment jsdom
 */

import { render, cleanup, act } from "@testing-library/react"

const mockIsTauri = jest.fn(() => true)
const mockDispatchShortcut = jest.fn()

jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({
    dispatchShortcut: (id: string) => mockDispatchShortcut(id),
  }),
}))

import { TerminalToggleShortcut } from "./terminal-toggle-shortcut"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

afterEach(() => {
  cleanup()
  useTerminalStore.getState().reset()
  mockIsTauri.mockReturnValue(true)
  mockDispatchShortcut.mockReset()
})

function fireCtrlBacktick(target?: EventTarget): void {
  const event = new KeyboardEvent("keydown", {
    key: "`",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  if (target) Object.defineProperty(event, "target", { value: target })
  window.dispatchEvent(event)
}

describe("TerminalToggleShortcut", () => {
  it("toggles panelOpen on Ctrl+`", () => {
    render(<TerminalToggleShortcut />)
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    act(() => {
      fireCtrlBacktick()
    })
    expect(useTerminalStore.getState().panelOpen).toBe(true)
    act(() => {
      fireCtrlBacktick()
    })
    expect(useTerminalStore.getState().panelOpen).toBe(false)
  })

  it("fires dispatchShortcut('terminal.toggle') on each press", () => {
    render(<TerminalToggleShortcut />)
    act(() => {
      fireCtrlBacktick()
    })
    expect(mockDispatchShortcut).toHaveBeenCalledWith("terminal.toggle")
  })

  it("does not steal the chord when target is a text input", () => {
    render(<TerminalToggleShortcut />)
    const input = document.createElement("input")
    document.body.appendChild(input)
    act(() => {
      fireCtrlBacktick(input)
    })
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    input.remove()
  })

  it("does not steal the chord when target is a textarea", () => {
    render(<TerminalToggleShortcut />)
    const ta = document.createElement("textarea")
    document.body.appendChild(ta)
    act(() => {
      fireCtrlBacktick(ta)
    })
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    ta.remove()
  })

  it("does not steal the chord when target is contenteditable", () => {
    render(<TerminalToggleShortcut />)
    const div = document.createElement("div")
    div.setAttribute("contenteditable", "true")
    document.body.appendChild(div)
    act(() => {
      fireCtrlBacktick(div)
    })
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    div.remove()
  })

  it("is a no-op when not running under Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    render(<TerminalToggleShortcut />)
    act(() => {
      fireCtrlBacktick()
    })
    expect(useTerminalStore.getState().panelOpen).toBe(false)
    expect(mockDispatchShortcut).not.toHaveBeenCalled()
  })

  it("unregisters its keydown listener on unmount", () => {
    const { unmount } = render(<TerminalToggleShortcut />)
    unmount()
    act(() => {
      fireCtrlBacktick()
    })
    expect(useTerminalStore.getState().panelOpen).toBe(false)
  })

  it("ignores plain ` without Ctrl/Cmd", () => {
    render(<TerminalToggleShortcut />)
    act(() => {
      const event = new KeyboardEvent("keydown", { key: "`", bubbles: true })
      window.dispatchEvent(event)
    })
    expect(useTerminalStore.getState().panelOpen).toBe(false)
  })
})
