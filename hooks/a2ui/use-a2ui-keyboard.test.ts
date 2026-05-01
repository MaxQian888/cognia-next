/**
 * Tests for useA2UIKeyboard, useA2UIFocusTrap, and useA2UIListNavigation hooks
 */

import { renderHook, act } from "@testing-library/react"
import { useA2UIKeyboard, useA2UIFocusTrap, useA2UIListNavigation } from "./use-a2ui-keyboard"

describe("useA2UIKeyboard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    // Clean up any event listeners
    document.removeEventListener("keydown", jest.fn())
  })

  describe("initialization", () => {
    it("should return handleKeyDown function", () => {
      const { result } = renderHook(() => useA2UIKeyboard())

      expect(result.current.handleKeyDown).toBeDefined()
      expect(typeof result.current.handleKeyDown).toBe("function")
    })

    it("should be enabled by default", () => {
      const onEnter = jest.fn()
      renderHook(() => useA2UIKeyboard({ onEnter }))

      const event = new KeyboardEvent("keydown", { key: "Enter" })
      document.dispatchEvent(event)

      expect(onEnter).toHaveBeenCalled()
    })

    it("should not respond when disabled", () => {
      const onEnter = jest.fn()
      renderHook(() => useA2UIKeyboard({ onEnter, enabled: false }))

      const event = new KeyboardEvent("keydown", { key: "Enter" })
      document.dispatchEvent(event)

      expect(onEnter).not.toHaveBeenCalled()
    })
  })

  describe("key handlers", () => {
    it("should call onEnter when Enter is pressed", () => {
      const onEnter = jest.fn()
      renderHook(() => useA2UIKeyboard({ onEnter }))

      const event = new KeyboardEvent("keydown", { key: "Enter" })
      document.dispatchEvent(event)

      expect(onEnter).toHaveBeenCalled()
    })

    it("should call onEscape when Escape is pressed", () => {
      const onEscape = jest.fn()
      renderHook(() => useA2UIKeyboard({ onEscape }))

      const event = new KeyboardEvent("keydown", { key: "Escape" })
      document.dispatchEvent(event)

      expect(onEscape).toHaveBeenCalled()
    })

    it("should call onArrowUp when ArrowUp is pressed", () => {
      const onArrowUp = jest.fn()
      renderHook(() => useA2UIKeyboard({ onArrowUp }))

      const event = new KeyboardEvent("keydown", { key: "ArrowUp" })
      document.dispatchEvent(event)

      expect(onArrowUp).toHaveBeenCalled()
    })

    it("should call onArrowDown when ArrowDown is pressed", () => {
      const onArrowDown = jest.fn()
      renderHook(() => useA2UIKeyboard({ onArrowDown }))

      const event = new KeyboardEvent("keydown", { key: "ArrowDown" })
      document.dispatchEvent(event)

      expect(onArrowDown).toHaveBeenCalled()
    })

    it("should call onArrowLeft when ArrowLeft is pressed", () => {
      const onArrowLeft = jest.fn()
      renderHook(() => useA2UIKeyboard({ onArrowLeft }))

      const event = new KeyboardEvent("keydown", { key: "ArrowLeft" })
      document.dispatchEvent(event)

      expect(onArrowLeft).toHaveBeenCalled()
    })

    it("should call onArrowRight when ArrowRight is pressed", () => {
      const onArrowRight = jest.fn()
      renderHook(() => useA2UIKeyboard({ onArrowRight }))

      const event = new KeyboardEvent("keydown", { key: "ArrowRight" })
      document.dispatchEvent(event)

      expect(onArrowRight).toHaveBeenCalled()
    })

    it("should call onTab with shiftKey when Tab is pressed", () => {
      const onTab = jest.fn()
      renderHook(() => useA2UIKeyboard({ onTab }))

      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true })
      document.dispatchEvent(event)

      expect(onTab).toHaveBeenCalledWith(true)
    })

    it("should call onTab without shiftKey when Tab is pressed without Shift", () => {
      const onTab = jest.fn()
      renderHook(() => useA2UIKeyboard({ onTab }))

      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: false })
      document.dispatchEvent(event)

      expect(onTab).toHaveBeenCalledWith(false)
    })
  })

  describe("cleanup", () => {
    it("should remove event listener on unmount", () => {
      const onEnter = jest.fn()
      const { unmount } = renderHook(() => useA2UIKeyboard({ onEnter }))

      unmount()

      const event = new KeyboardEvent("keydown", { key: "Enter" })
      document.dispatchEvent(event)

      expect(onEnter).not.toHaveBeenCalled()
    })

    it("should remove event listener when disabled changes to false", () => {
      const onEnter = jest.fn()
      const { rerender } = renderHook(({ enabled }) => useA2UIKeyboard({ onEnter, enabled }), {
        initialProps: { enabled: true },
      })

      // Initially enabled
      const event1 = new KeyboardEvent("keydown", { key: "Enter" })
      document.dispatchEvent(event1)
      expect(onEnter).toHaveBeenCalledTimes(1)

      // Disable
      rerender({ enabled: false })

      const event2 = new KeyboardEvent("keydown", { key: "Enter" })
      document.dispatchEvent(event2)
      expect(onEnter).toHaveBeenCalledTimes(1) // Still 1, not called again
    })
  })
})

describe("useA2UIFocusTrap", () => {
  let container: HTMLDivElement
  let containerRef: React.RefObject<HTMLDivElement>

  beforeEach(() => {
    container = document.createElement("div")
    container.innerHTML = `
      <button id="btn1">Button 1</button>
      <input id="input1" type="text" />
      <button id="btn2" disabled>Disabled Button</button>
      <a id="link1" href="#">Link</a>
      <div tabindex="0" id="div1">Focusable Div</div>
      <div tabindex="-1" id="div2">Not Focusable</div>
    `
    document.body.appendChild(container)

    containerRef = { current: container }
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  describe("updateFocusableElements", () => {
    it("should find focusable elements", () => {
      const { result } = renderHook(() => useA2UIFocusTrap(containerRef))

      act(() => {
        result.current.updateFocusableElements()
      })

      // Check focusFirst works (which means elements were found)
      act(() => {
        result.current.focusFirst()
      })

      expect(document.activeElement?.id).toBe("btn1")
    })
  })

  describe("focusFirst", () => {
    it("should focus the first focusable element", () => {
      const { result } = renderHook(() => useA2UIFocusTrap(containerRef))

      act(() => {
        result.current.focusFirst()
      })

      expect(document.activeElement?.id).toBe("btn1")
    })
  })

  describe("focusLast", () => {
    it("should focus the last focusable element", () => {
      const { result } = renderHook(() => useA2UIFocusTrap(containerRef))

      act(() => {
        result.current.focusLast()
      })

      expect(document.activeElement?.id).toBe("div1")
    })
  })

  describe("focusNext", () => {
    it("should focus the next focusable element", () => {
      const { result } = renderHook(() => useA2UIFocusTrap(containerRef))

      act(() => {
        result.current.focusFirst()
      })

      expect(document.activeElement?.id).toBe("btn1")

      act(() => {
        result.current.focusNext()
      })

      expect(document.activeElement?.id).toBe("input1")
    })

    it("should wrap to first element when at the end", () => {
      const { result } = renderHook(() => useA2UIFocusTrap(containerRef))

      act(() => {
        result.current.focusLast()
      })

      expect(document.activeElement?.id).toBe("div1")

      act(() => {
        result.current.focusNext()
      })

      expect(document.activeElement?.id).toBe("btn1")
    })
  })

  describe("focusPrevious", () => {
    it("should focus the previous focusable element", () => {
      const { result } = renderHook(() => useA2UIFocusTrap(containerRef))

      // Start at second element
      act(() => {
        result.current.focusFirst()
        result.current.focusNext()
      })

      expect(document.activeElement?.id).toBe("input1")

      act(() => {
        result.current.focusPrevious()
      })

      expect(document.activeElement?.id).toBe("btn1")
    })

    it("should wrap to last element when at the beginning", () => {
      const { result } = renderHook(() => useA2UIFocusTrap(containerRef))

      act(() => {
        result.current.focusFirst()
      })

      expect(document.activeElement?.id).toBe("btn1")

      act(() => {
        result.current.focusPrevious()
      })

      expect(document.activeElement?.id).toBe("div1")
    })
  })

  describe("edge cases", () => {
    it("should handle empty container", () => {
      const emptyContainer = document.createElement("div")
      document.body.appendChild(emptyContainer)
      const emptyRef = { current: emptyContainer }

      const { result } = renderHook(() => useA2UIFocusTrap(emptyRef))

      // Should not throw
      act(() => {
        result.current.focusFirst()
        result.current.focusLast()
        result.current.focusNext()
        result.current.focusPrevious()
      })

      document.body.removeChild(emptyContainer)
    })

    it("should handle null ref", () => {
      const nullRef = { current: null } as unknown as React.RefObject<HTMLElement>

      const { result } = renderHook(() => useA2UIFocusTrap(nullRef))

      // Should not throw
      act(() => {
        result.current.updateFocusableElements()
      })
    })
  })
})

describe("useA2UIListNavigation", () => {
  const items = ["item1", "item2", "item3", "item4"]

  describe("initialization", () => {
    it("should start at index 0", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      expect(result.current.getActiveIndex()).toBe(0)
    })
  })

  describe("setActiveIndex", () => {
    it("should set active index", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      act(() => {
        result.current.setActiveIndex(2)
      })

      expect(result.current.getActiveIndex()).toBe(2)
    })

    it("should loop by default when index exceeds length", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      act(() => {
        result.current.setActiveIndex(5)
      })

      expect(result.current.getActiveIndex()).toBe(1) // 5 % 4 = 1
    })

    it("should loop when index is negative", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      act(() => {
        result.current.setActiveIndex(-1)
      })

      expect(result.current.getActiveIndex()).toBe(3) // Last item
    })

    it("should clamp when loop is false and index exceeds length", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items, { loop: false }))

      act(() => {
        result.current.setActiveIndex(10)
      })

      expect(result.current.getActiveIndex()).toBe(3) // Clamped to last index
    })

    it("should clamp when loop is false and index is negative", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items, { loop: false }))

      act(() => {
        result.current.setActiveIndex(-5)
      })

      expect(result.current.getActiveIndex()).toBe(0) // Clamped to 0
    })
  })

  describe("moveUp", () => {
    it("should decrease active index", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      act(() => {
        result.current.setActiveIndex(2)
      })

      let newIndex: number
      act(() => {
        newIndex = result.current.moveUp()
      })

      expect(newIndex!).toBe(1)
      expect(result.current.getActiveIndex()).toBe(1)
    })

    it("should wrap to last item when at index 0 with loop", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      let newIndex: number
      act(() => {
        newIndex = result.current.moveUp()
      })

      expect(newIndex!).toBe(3)
    })
  })

  describe("moveDown", () => {
    it("should increase active index", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      let newIndex: number
      act(() => {
        newIndex = result.current.moveDown()
      })

      expect(newIndex!).toBe(1)
      expect(result.current.getActiveIndex()).toBe(1)
    })

    it("should wrap to first item when at last index with loop", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      act(() => {
        result.current.setActiveIndex(3)
      })

      let newIndex: number
      act(() => {
        newIndex = result.current.moveDown()
      })

      expect(newIndex!).toBe(0)
    })
  })

  describe("selectCurrent", () => {
    it("should call onSelect with current item and index", () => {
      const onSelect = jest.fn()
      const { result } = renderHook(() => useA2UIListNavigation(items, { onSelect }))

      act(() => {
        result.current.setActiveIndex(2)
      })

      act(() => {
        result.current.selectCurrent()
      })

      expect(onSelect).toHaveBeenCalledWith("item3", 2)
    })

    it("should not call onSelect if items array is empty", () => {
      const onSelect = jest.fn()
      const { result } = renderHook(() => useA2UIListNavigation([], { onSelect }))

      act(() => {
        result.current.selectCurrent()
      })

      expect(onSelect).not.toHaveBeenCalled()
    })

    it("should not throw if onSelect is not provided", () => {
      const { result } = renderHook(() => useA2UIListNavigation(items))

      // Should not throw
      act(() => {
        result.current.selectCurrent()
      })
    })
  })

  describe("edge cases", () => {
    it("should handle empty items array", () => {
      const { result } = renderHook(() => useA2UIListNavigation([]))

      // Should not throw
      act(() => {
        result.current.setActiveIndex(5)
        result.current.moveUp()
        result.current.moveDown()
      })

      expect(result.current.getActiveIndex()).toBe(0)
    })

    it("should handle single item array", () => {
      const onSelect = jest.fn()
      const { result } = renderHook(() => useA2UIListNavigation(["only"], { onSelect }))

      act(() => {
        result.current.moveDown()
      })

      expect(result.current.getActiveIndex()).toBe(0)

      act(() => {
        result.current.selectCurrent()
      })

      expect(onSelect).toHaveBeenCalledWith("only", 0)
    })
  })
})
