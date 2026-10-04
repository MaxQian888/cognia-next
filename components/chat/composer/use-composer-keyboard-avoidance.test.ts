/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { useComposerKeyboardAvoidance } from "./use-composer-keyboard-avoidance"

const keyboard = { open: false, overlap: 0, viewportHeight: 800, nativeHeight: 0 }
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardViewport: () => keyboard,
}))

const dockMotion = jest.fn()
jest.mock("@/hooks/ui/use-keyboard-dock-motion", () => ({
  useKeyboardDockMotion: (el: HTMLElement | null, enabled: boolean) => dockMotion(el, enabled),
}))

jest.mock("@cognia/plugin-ui/motion-tokens", () => ({
  readReducedMotion: jest.fn(() => false),
}))

import { readReducedMotion } from "@cognia/plugin-ui/motion-tokens"

const mockReduced = readReducedMotion as jest.Mock

function mountComposer() {
  const root = document.createElement("div")
  const textarea = document.createElement("textarea")
  root.appendChild(textarea)
  document.body.appendChild(root)
  const scrollIntoView = jest.fn()
  root.scrollIntoView = scrollIntoView
  return { root, textarea, scrollIntoView }
}

beforeEach(() => {
  keyboard.open = false
  keyboard.viewportHeight = 800
  dockMotion.mockReset()
  mockReduced.mockReset().mockReturnValue(false)
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0)
    return 1
  })
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("useComposerKeyboardAvoidance", () => {
  it("glides the docked composer with the keyboard", () => {
    const { root } = mountComposer()
    renderHook(() => useComposerKeyboardAvoidance({ root, placement: "docked", enabled: true }))
    expect(dockMotion).toHaveBeenLastCalledWith(root, true)
  })

  it("does not glide the hero composer or anything off a soft-keyboard device", () => {
    const { root } = mountComposer()
    renderHook(() => useComposerKeyboardAvoidance({ root, placement: "hero", enabled: true }))
    expect(dockMotion).toHaveBeenLastCalledWith(root, false)
    renderHook(() => useComposerKeyboardAvoidance({ root, placement: "docked", enabled: false }))
    expect(dockMotion).toHaveBeenLastCalledWith(root, false)
  })

  it("scrolls the whole hero composer into view when the keyboard opens on it", () => {
    const { root, textarea, scrollIntoView } = mountComposer()
    textarea.focus()
    const { rerender } = renderHook(() =>
      useComposerKeyboardAvoidance({ root, placement: "hero", enabled: true })
    )
    expect(scrollIntoView).not.toHaveBeenCalled()

    keyboard.open = true
    keyboard.viewportHeight = 480
    rerender()
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    })
  })

  it("re-checks when the visible height changes while open", () => {
    const { root, textarea, scrollIntoView } = mountComposer()
    textarea.focus()
    keyboard.open = true
    const { rerender } = renderHook(() =>
      useComposerKeyboardAvoidance({ root, placement: "hero", enabled: true })
    )
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    keyboard.viewportHeight = 420
    rerender()
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })

  it("jumps instead of smooth-scrolling under reduced motion", () => {
    mockReduced.mockReturnValue(true)
    const { root, textarea, scrollIntoView } = mountComposer()
    textarea.focus()
    keyboard.open = true
    renderHook(() => useComposerKeyboardAvoidance({ root, placement: "hero", enabled: true }))
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }))
  })

  it("leaves the page alone when focus is elsewhere", () => {
    const { root, scrollIntoView } = mountComposer()
    const other = document.createElement("input")
    document.body.appendChild(other)
    other.focus()
    keyboard.open = true
    renderHook(() => useComposerKeyboardAvoidance({ root, placement: "hero", enabled: true }))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it("never scrolls a docked composer (the column already ends at the keyboard)", () => {
    const { root, textarea, scrollIntoView } = mountComposer()
    textarea.focus()
    keyboard.open = true
    renderHook(() => useComposerKeyboardAvoidance({ root, placement: "docked", enabled: true }))
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
