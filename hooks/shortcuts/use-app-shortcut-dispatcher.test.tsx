/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

const dispatchShortcut = jest.fn()
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({ dispatchShortcut }),
}))

import { useAppShortcutDispatcher } from "./use-app-shortcut-dispatcher"
import { registerAppShortcut, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import {
  useAppKeybindingStore,
  __resetAppKeybindingStoreForTesting,
} from "@/stores/shortcuts/app-keybinding-store"
import {
  setContextKeys,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe("useAppShortcutDispatcher", () => {
  let unmount: () => void

  beforeEach(() => {
    __resetAppRuntimeForTesting()
    __resetAppKeybindingStoreForTesting()
    __resetContextKeysForTesting()
    localStorage.clear()
    dispatchShortcut.mockClear()
    unmount = renderHook(() => useAppShortcutDispatcher()).unmount
  })

  afterEach(() => unmount())

  it("fires the handler for a matching default chord and notifies plugins", () => {
    const handler = jest.fn()
    registerAppShortcut({ id: "app.search.focus", handler })
    press(window, { key: "/" })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(dispatchShortcut).toHaveBeenCalledWith("app.search.focus")
  })

  it("does nothing when no registered shortcut accepts the chord", () => {
    const handler = jest.fn()
    registerAppShortcut({ id: "app.search.focus", handler })
    press(window, { key: "x" })
    expect(handler).not.toHaveBeenCalled()
    expect(dispatchShortcut).not.toHaveBeenCalled()
  })

  it("does not hijack a keystroke that lands in an editable control", () => {
    const handler = jest.fn()
    registerAppShortcut({ id: "app.search.focus", handler })
    const input = document.createElement("input")
    document.body.appendChild(input)
    press(input, { key: "/" })
    expect(handler).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it("fires inside an editable control when allowInEditable is set", () => {
    const handler = jest.fn()
    registerAppShortcut({ id: "app.search.focus", handler, allowInEditable: true })
    const input = document.createElement("input")
    document.body.appendChild(input)
    press(input, { key: "/" })
    expect(handler).toHaveBeenCalledTimes(1)
    document.body.removeChild(input)
  })

  it("never fires inside a declared code editor, even with allowInEditable", () => {
    const handler = jest.fn()
    registerAppShortcut({
      id: "app.search.focus",
      handler,
      allowInEditable: true,
      editorSelectors: [".monaco-editor"],
    })
    const editor = document.createElement("div")
    editor.className = "monaco-editor"
    const inner = document.createElement("span")
    editor.appendChild(inner)
    document.body.appendChild(editor)

    press(inner, { key: "/" })
    expect(handler).not.toHaveBeenCalled()

    // Same registration fires normally outside the editor surface.
    press(window, { key: "/" })
    expect(handler).toHaveBeenCalledTimes(1)
    document.body.removeChild(editor)
  })

  it("calls preventDefault when the registration requests it", () => {
    registerAppShortcut({ id: "app.search.focus", handler: jest.fn(), preventDefault: true })
    const event = press(window, { key: "/" })
    expect(event.defaultPrevented).toBe(true)
  })

  it("skips a shortcut whose when clause is false and fires it once true", () => {
    const handler = jest.fn()
    registerAppShortcut({ id: "terminal.toggle", handler, when: "platform.tauri" })

    press(window, { key: "`", ctrlKey: true })
    expect(handler).not.toHaveBeenCalled()

    setContextKeys({ "platform.tauri": true })
    press(window, { key: "`", ctrlKey: true })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("follows a user override to the new chord", () => {
    const handler = jest.fn()
    useAppKeybindingStore.getState().setOverride("app.search.focus", "Ctrl+P")
    registerAppShortcut({ id: "app.search.focus", handler })

    press(window, { key: "/" })
    expect(handler).not.toHaveBeenCalled()

    press(window, { key: "p", ctrlKey: true })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("fires only the first matching registration (first-match-wins)", () => {
    const first = jest.fn()
    const second = jest.fn()
    setContextKeys({ "platform.tauri": true })
    // Both accept "/" once zoom.in is remapped onto it.
    useAppKeybindingStore.getState().setOverride("zoom.in", "/")
    registerAppShortcut({ id: "app.search.focus", handler: first })
    registerAppShortcut({ id: "zoom.in", handler: second, when: "platform.tauri" })

    press(window, { key: "/" })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it("skips a guarded first hit and fires the next eligible one", () => {
    const guarded = jest.fn()
    const eligible = jest.fn()
    // zoom.in remapped to "/" but its when is false → skipped; search fires.
    useAppKeybindingStore.getState().setOverride("zoom.in", "/")
    registerAppShortcut({ id: "zoom.in", handler: guarded, when: "platform.tauri" })
    registerAppShortcut({ id: "app.search.focus", handler: eligible })

    press(window, { key: "/" })
    expect(guarded).not.toHaveBeenCalled()
    expect(eligible).toHaveBeenCalledTimes(1)
  })
})
