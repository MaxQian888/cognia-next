/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { renderHook } from "@testing-library/react"

import { useSearchHotkey } from "./use-search-hotkey"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"

// The modifier / editable-target guards now live in the single app-shortcut
// dispatcher (covered by its own test). Here we verify this hook's contract:
// it registers `app.search.focus` while mounted and its handler focuses the ref.

function setRef(input: HTMLInputElement | null) {
  const ref = createRef<HTMLInputElement>()
  ;(ref as { current: HTMLInputElement | null }).current = input
  return ref
}

describe("useSearchHotkey", () => {
  beforeEach(() => __resetAppRuntimeForTesting())

  it("registers app.search.focus while mounted and removes it on unmount", () => {
    const { unmount } = renderHook(() => useSearchHotkey(setRef(null)))
    expect(getAppRegistration("app.search.focus")).toBeDefined()
    unmount()
    expect(getAppRegistration("app.search.focus")).toBeUndefined()
  })

  it("focuses the input and prevents default when fired", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    const focusSpy = jest.spyOn(input, "focus")

    renderHook(() => useSearchHotkey(setRef(input)))
    const event = new KeyboardEvent("keydown", { key: "/", cancelable: true })
    getAppRegistration("app.search.focus")?.handler(event)

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    input.remove()
  })

  it("does nothing and leaves the event alone when the ref is empty", () => {
    renderHook(() => useSearchHotkey(setRef(null)))
    const event = new KeyboardEvent("keydown", { key: "/", cancelable: true })
    expect(() => getAppRegistration("app.search.focus")?.handler(event)).not.toThrow()
    expect(event.defaultPrevented).toBe(false)
  })
})
