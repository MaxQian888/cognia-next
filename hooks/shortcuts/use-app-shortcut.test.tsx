/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import { useAppShortcut } from "./use-app-shortcut"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"

describe("useAppShortcut", () => {
  beforeEach(() => __resetAppRuntimeForTesting())

  it("registers a handler on mount and removes it on unmount", () => {
    const { unmount } = renderHook(() => useAppShortcut("terminal.toggle", jest.fn()))
    expect(getAppRegistration("terminal.toggle")).toBeDefined()
    unmount()
    expect(getAppRegistration("terminal.toggle")).toBeUndefined()
  })

  it("does not register when enabled is false, and (un)registers as it flips", () => {
    const { rerender } = renderHook(
      ({ on }) => useAppShortcut("terminal.toggle", jest.fn(), { enabled: on }),
      { initialProps: { on: false } }
    )
    expect(getAppRegistration("terminal.toggle")).toBeUndefined()
    rerender({ on: true })
    expect(getAppRegistration("terminal.toggle")).toBeDefined()
    rerender({ on: false })
    expect(getAppRegistration("terminal.toggle")).toBeUndefined()
  })

  it("inherits the catalog descriptor's when clause by default", () => {
    renderHook(() => useAppShortcut("terminal.toggle", jest.fn()))
    expect(getAppRegistration("terminal.toggle")?.when).toBe("platform.tauri")
  })

  it("lets options override the when clause and pass flags through", () => {
    renderHook(() =>
      useAppShortcut("terminal.toggle", jest.fn(), {
        when: "route.settings",
        preventDefault: true,
        allowInEditable: true,
        editorSelectors: [".monaco-editor"],
        commandId: "custom.cmd",
      })
    )
    const registration = getAppRegistration("terminal.toggle")
    expect(registration?.when).toBe("route.settings")
    expect(registration?.preventDefault).toBe(true)
    expect(registration?.allowInEditable).toBe(true)
    expect(registration?.editorSelectors).toEqual([".monaco-editor"])
    expect(registration?.commandId).toBe("custom.cmd")
  })

  it("calls the latest handler without re-registering when the handler identity changes", () => {
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = renderHook(({ h }) => useAppShortcut("app.search.focus", h), {
      initialProps: { h: first },
    })
    const before = getAppRegistration("app.search.focus")
    rerender({ h: second })
    const after = getAppRegistration("app.search.focus")

    expect(after).toBe(before) // same registration object — no runtime churn

    const event = new KeyboardEvent("keydown")
    after?.handler(event)
    expect(second).toHaveBeenCalledWith(event)
    expect(first).not.toHaveBeenCalled()
  })
})
