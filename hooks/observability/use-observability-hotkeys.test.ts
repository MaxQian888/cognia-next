/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import { isEditableTarget, useObservabilityHotkeys } from "./use-observability-hotkeys"

function press(key: string, opts: KeyboardEventInit = {}, target: EventTarget = window) {
  const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts })
  target.dispatchEvent(evt)
  return evt
}

describe("isEditableTarget", () => {
  it("is true for inputs, textareas, selects and contenteditable", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true)
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true)
    expect(isEditableTarget(document.createElement("select"))).toBe(true)
    const div = document.createElement("div")
    Object.defineProperty(div, "isContentEditable", { value: true })
    expect(isEditableTarget(div)).toBe(true)
  })
  it("is false for non-elements and plain elements", () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(document.createElement("div"))).toBe(false)
  })
})

describe("useObservabilityHotkeys", () => {
  it("dispatches e/r/f/s to their handlers", () => {
    const h = {
      onToggleEdit: jest.fn(),
      onRefresh: jest.fn(),
      onFocusFilter: jest.fn(),
      onOpenSettings: jest.fn(),
    }
    renderHook(() => useObservabilityHotkeys(h))
    press("e")
    press("r")
    press("f")
    press("s")
    expect(h.onToggleEdit).toHaveBeenCalledTimes(1)
    expect(h.onRefresh).toHaveBeenCalledTimes(1)
    expect(h.onFocusFilter).toHaveBeenCalledTimes(1)
    expect(h.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it("is case-insensitive and calls preventDefault", () => {
    const onToggleEdit = jest.fn()
    renderHook(() => useObservabilityHotkeys({ onToggleEdit }))
    const evt = press("E")
    expect(onToggleEdit).toHaveBeenCalled()
    expect(evt.defaultPrevented).toBe(true)
  })

  it("ignores presses with modifiers", () => {
    const onRefresh = jest.fn()
    renderHook(() => useObservabilityHotkeys({ onRefresh }))
    press("r", { ctrlKey: true })
    press("r", { metaKey: true })
    press("r", { altKey: true })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("ignores presses that originate from an editable field", () => {
    const onToggleEdit = jest.fn()
    renderHook(() => useObservabilityHotkeys({ onToggleEdit }))
    const input = document.createElement("input")
    document.body.appendChild(input)
    press("e", {}, input)
    expect(onToggleEdit).not.toHaveBeenCalled()
    input.remove()
  })

  it("no-ops for keys without a handler and unmounts cleanly", () => {
    const onRefresh = jest.fn()
    const { unmount } = renderHook(() => useObservabilityHotkeys({ onRefresh }))
    // 'e' has no handler → does nothing, no throw.
    expect(press("e").defaultPrevented).toBe(false)
    unmount()
    press("r")
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it("always reads the latest handlers", () => {
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = renderHook(({ fn }) => useObservabilityHotkeys({ onRefresh: fn }), {
      initialProps: { fn: first },
    })
    rerender({ fn: second })
    press("r")
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
