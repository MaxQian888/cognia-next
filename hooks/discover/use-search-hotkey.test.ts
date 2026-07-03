/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { renderHook } from "@testing-library/react"

import { useSearchHotkey } from "./use-search-hotkey"

function pressSlash(target: EventTarget, init: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe("useSearchHotkey", () => {
  it("focuses the input when '/' is pressed outside a field", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    const ref = createRef<HTMLInputElement>()
    ;(ref as { current: HTMLInputElement | null }).current = input
    const focusSpy = jest.spyOn(input, "focus")

    renderHook(() => useSearchHotkey(ref))
    const event = pressSlash(document.body)

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    input.remove()
  })

  it("ignores '/' typed inside an input", () => {
    const input = document.createElement("input")
    const field = document.createElement("input")
    document.body.append(input, field)
    const ref = createRef<HTMLInputElement>()
    ;(ref as { current: HTMLInputElement | null }).current = input
    const focusSpy = jest.spyOn(input, "focus")

    renderHook(() => useSearchHotkey(ref))
    pressSlash(field)

    expect(focusSpy).not.toHaveBeenCalled()
    input.remove()
    field.remove()
  })

  it("ignores '/' when a modifier is held", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    const ref = createRef<HTMLInputElement>()
    ;(ref as { current: HTMLInputElement | null }).current = input
    const focusSpy = jest.spyOn(input, "focus")

    renderHook(() => useSearchHotkey(ref))
    pressSlash(document.body, { metaKey: true })
    pressSlash(document.body, { ctrlKey: true })

    expect(focusSpy).not.toHaveBeenCalled()
    input.remove()
  })

  it("does nothing when the ref is empty", () => {
    const ref = createRef<HTMLInputElement>()
    renderHook(() => useSearchHotkey(ref))
    // Just asserting no throw when there is no input to focus.
    expect(() => pressSlash(document.body)).not.toThrow()
  })

  it("removes its listener on unmount", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    const ref = createRef<HTMLInputElement>()
    ;(ref as { current: HTMLInputElement | null }).current = input
    const focusSpy = jest.spyOn(input, "focus")

    const { unmount } = renderHook(() => useSearchHotkey(ref))
    unmount()
    pressSlash(document.body)

    expect(focusSpy).not.toHaveBeenCalled()
    input.remove()
  })
})
