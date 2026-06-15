/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"
import { act } from "react"

const replaceMock = jest.fn()
let searchString = ""

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchString),
}))

import { useSettingFocus } from "./use-setting-focus"

beforeEach(() => {
  jest.useFakeTimers()
  replaceMock.mockClear()
  searchString = ""
  document.body.innerHTML = ""
  // jsdom doesn't implement scrollIntoView.
  Element.prototype.scrollIntoView = jest.fn()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("useSettingFocus", () => {
  it("does nothing without a focus param", () => {
    renderHook(() => useSettingFocus())
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("ignores a malformed focus id", () => {
    searchString = "focus=bad id!!"
    renderHook(() => useSettingFocus())
    act(() => {
      jest.advanceTimersByTime(100)
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("scrolls, highlights, and clears the param when the anchor exists", () => {
    const el = document.createElement("div")
    el.setAttribute("data-setting-id", "default-model")
    document.body.appendChild(el)
    searchString = "section=general&focus=default-model"

    renderHook(() => useSettingFocus())
    act(() => {
      jest.advanceTimersByTime(0)
    })

    expect(el.scrollIntoView).toHaveBeenCalled()
    expect(el.classList.contains("ring-2")).toBe(true)
    expect(replaceMock).toHaveBeenCalledTimes(1)
    expect(replaceMock.mock.calls[0][0]).not.toContain("focus")
    expect(replaceMock.mock.calls[0][0]).toContain("section=general")

    // Highlight is removed after the timeout.
    act(() => {
      jest.advanceTimersByTime(2000)
    })
    expect(el.classList.contains("ring-2")).toBe(false)
  })

  it("clears the param after the retry budget when no anchor mounts", () => {
    searchString = "focus=never-here"
    renderHook(() => useSettingFocus())
    act(() => {
      jest.advanceTimersByTime(60 * 21)
    })
    expect(replaceMock).toHaveBeenCalledTimes(1)
    expect(replaceMock.mock.calls[0][0]).not.toContain("focus")
  })
})
