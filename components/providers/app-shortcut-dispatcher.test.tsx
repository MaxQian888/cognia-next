/** @jest-environment jsdom */

import { render } from "@testing-library/react"

const dispatchShortcut = jest.fn()
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({ dispatchShortcut }),
}))

import { AppShortcutDispatcher } from "./app-shortcut-dispatcher"
import { registerAppShortcut, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"

describe("AppShortcutDispatcher", () => {
  beforeEach(() => {
    __resetAppRuntimeForTesting()
    __resetAppKeybindingStoreForTesting()
    localStorage.clear()
    dispatchShortcut.mockClear()
  })

  it("renders nothing", () => {
    const { container } = render(<AppShortcutDispatcher />)
    expect(container).toBeEmptyDOMElement()
  })

  it("mounts a live dispatcher that drives registered app shortcuts", () => {
    render(<AppShortcutDispatcher />)
    const handler = jest.fn()
    registerAppShortcut({ id: "app.search.focus", handler })
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("tears down the listener on unmount", () => {
    const { unmount } = render(<AppShortcutDispatcher />)
    unmount()
    const handler = jest.fn()
    registerAppShortcut({ id: "app.search.focus", handler })
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }))
    expect(handler).not.toHaveBeenCalled()
  })
})
