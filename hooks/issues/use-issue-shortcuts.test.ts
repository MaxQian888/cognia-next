/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import { useIssueShortcuts } from "./use-issue-shortcuts"

function press(key: string, target?: Element, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  ;(target ?? document.body).dispatchEvent(event)
  return event
}

describe("useIssueShortcuts", () => {
  it("fires the handler for a mapped key", () => {
    const create = jest.fn()
    renderHook(() => useIssueShortcuts({ create }))
    press("c")
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("prevents the default so the key does not also reach the page", () => {
    renderHook(() => useIssueShortcuts({ create: jest.fn() }))
    expect(press("c").defaultPrevented).toBe(true)
  })

  it("lets an unhandled action fall through untouched", () => {
    renderHook(() => useIssueShortcuts({ create: jest.fn() }))
    // `j` is mapped to `next`, which this caller does not handle.
    expect(press("j").defaultPrevented).toBe(false)
  })

  it("ignores an unmapped key entirely", () => {
    renderHook(() => useIssueShortcuts({ create: jest.fn() }))
    expect(press("q").defaultPrevented).toBe(false)
  })

  it("does not fire while typing", () => {
    const create = jest.fn()
    renderHook(() => useIssueShortcuts({ create }))
    const input = document.createElement("input")
    document.body.appendChild(input)
    press("c", input)
    expect(create).not.toHaveBeenCalled()
    input.remove()
  })

  it("is inert when disabled", () => {
    const create = jest.fn()
    renderHook(() => useIssueShortcuts({ create }, false))
    press("c")
    expect(create).not.toHaveBeenCalled()
  })

  it("uses the latest handler without re-attaching the listener", () => {
    const first = jest.fn()
    const second = jest.fn()
    const addSpy = jest.spyOn(document, "addEventListener")
    const { rerender } = renderHook(({ fn }) => useIssueShortcuts({ create: fn }), {
      initialProps: { fn: first },
    })
    const attachedOnce = addSpy.mock.calls.filter(([type]) => type === "keydown").length
    rerender({ fn: second })
    press("c")
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    expect(addSpy.mock.calls.filter(([type]) => type === "keydown").length).toBe(attachedOnce)
    addSpy.mockRestore()
  })

  it("detaches on unmount", () => {
    const create = jest.fn()
    const { unmount } = renderHook(() => useIssueShortcuts({ create }))
    unmount()
    press("c")
    expect(create).not.toHaveBeenCalled()
  })
})
