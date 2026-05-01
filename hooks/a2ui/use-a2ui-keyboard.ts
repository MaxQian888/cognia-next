"use client"

/**
 * A2UI Keyboard Navigation Hook
 * Provides keyboard navigation support for A2UI surfaces
 */

import { useCallback, useEffect, useRef } from "react"

export interface KeyboardNavigationOptions {
  onEnter?: () => void
  onEscape?: () => void
  onArrowUp?: () => void
  onArrowDown?: () => void
  onArrowLeft?: () => void
  onArrowRight?: () => void
  onTab?: (shiftKey: boolean) => void
  enabled?: boolean
}

export function useA2UIKeyboard(options: KeyboardNavigationOptions = {}) {
  const {
    onEnter,
    onEscape,
    onArrowUp,
    onArrowDown,
    onArrowLeft,
    onArrowRight,
    onTab,
    enabled = true,
  } = options

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return

      switch (e.key) {
        case "Enter":
          if (onEnter) {
            e.preventDefault()
            onEnter()
          }
          break
        case "Escape":
          if (onEscape) {
            e.preventDefault()
            onEscape()
          }
          break
        case "ArrowUp":
          if (onArrowUp) {
            e.preventDefault()
            onArrowUp()
          }
          break
        case "ArrowDown":
          if (onArrowDown) {
            e.preventDefault()
            onArrowDown()
          }
          break
        case "ArrowLeft":
          if (onArrowLeft) {
            e.preventDefault()
            onArrowLeft()
          }
          break
        case "ArrowRight":
          if (onArrowRight) {
            e.preventDefault()
            onArrowRight()
          }
          break
        case "Tab":
          if (onTab) {
            onTab(e.shiftKey)
          }
          break
      }
    },
    [enabled, onEnter, onEscape, onArrowUp, onArrowDown, onArrowLeft, onArrowRight, onTab]
  )

  useEffect(() => {
    if (enabled) {
      document.addEventListener("keydown", handleKeyDown)
      return () => document.removeEventListener("keydown", handleKeyDown)
    }
  }, [enabled, handleKeyDown])

  return { handleKeyDown }
}

/**
 * Hook for managing focus within a container
 */
export function useA2UIFocusTrap(containerRef: React.RefObject<HTMLElement | null>) {
  const focusableElementsRef = useRef<HTMLElement[]>([])
  const currentFocusIndexRef = useRef<number>(0)

  const updateFocusableElements = useCallback(() => {
    if (!containerRef.current) return

    const focusableSelectors = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "a[href]",
      '[tabindex]:not([tabindex="-1"])',
    ].join(", ")

    focusableElementsRef.current = Array.from(
      containerRef.current.querySelectorAll(focusableSelectors)
    ) as HTMLElement[]
  }, [containerRef])

  const focusFirst = useCallback(() => {
    updateFocusableElements()
    if (focusableElementsRef.current.length > 0) {
      focusableElementsRef.current[0].focus()
      currentFocusIndexRef.current = 0
    }
  }, [updateFocusableElements])

  const focusLast = useCallback(() => {
    updateFocusableElements()
    const elements = focusableElementsRef.current
    if (elements.length > 0) {
      elements[elements.length - 1].focus()
      currentFocusIndexRef.current = elements.length - 1
    }
  }, [updateFocusableElements])

  const focusNext = useCallback(() => {
    updateFocusableElements()
    const elements = focusableElementsRef.current
    if (elements.length === 0) return

    currentFocusIndexRef.current = (currentFocusIndexRef.current + 1) % elements.length
    elements[currentFocusIndexRef.current].focus()
  }, [updateFocusableElements])

  const focusPrevious = useCallback(() => {
    updateFocusableElements()
    const elements = focusableElementsRef.current
    if (elements.length === 0) return

    currentFocusIndexRef.current =
      (currentFocusIndexRef.current - 1 + elements.length) % elements.length
    elements[currentFocusIndexRef.current].focus()
  }, [updateFocusableElements])

  return {
    focusFirst,
    focusLast,
    focusNext,
    focusPrevious,
    updateFocusableElements,
  }
}

/**
 * Hook for handling list keyboard navigation
 */
export function useA2UIListNavigation<T>(
  items: T[],
  options: {
    onSelect?: (item: T, index: number) => void
    loop?: boolean
  } = {}
) {
  const { onSelect, loop = true } = options
  const activeIndexRef = useRef<number>(0)

  const setActiveIndex = useCallback(
    (index: number) => {
      if (items.length === 0) return

      let newIndex = index
      if (loop) {
        newIndex = ((index % items.length) + items.length) % items.length
      } else {
        newIndex = Math.max(0, Math.min(index, items.length - 1))
      }
      activeIndexRef.current = newIndex
    },
    [items.length, loop]
  )

  const moveUp = useCallback(() => {
    setActiveIndex(activeIndexRef.current - 1)
    return activeIndexRef.current
  }, [setActiveIndex])

  const moveDown = useCallback(() => {
    setActiveIndex(activeIndexRef.current + 1)
    return activeIndexRef.current
  }, [setActiveIndex])

  const selectCurrent = useCallback(() => {
    if (items.length > 0 && onSelect) {
      onSelect(items[activeIndexRef.current], activeIndexRef.current)
    }
  }, [items, onSelect])

  const getActiveIndex = useCallback(() => activeIndexRef.current, [])

  return {
    getActiveIndex,
    setActiveIndex,
    moveUp,
    moveDown,
    selectCurrent,
  }
}
