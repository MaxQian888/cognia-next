/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime"

import {
  recordNavigation,
  navigateBack,
  navigateForward,
  resetNavHistory,
  getNavHistorySnapshot,
  useNavHistory,
} from "./use-nav-history"

function makeRouter(): AppRouterInstance {
  return {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  } as unknown as AppRouterInstance
}

beforeEach(() => {
  resetNavHistory()
})

describe("use-nav-history", () => {
  it("starts with no back/forward available", () => {
    expect(getNavHistorySnapshot()).toEqual({ canBack: false, canForward: false })
  })

  it("enables back after two distinct paths and ignores repeats", () => {
    recordNavigation("/a")
    expect(getNavHistorySnapshot()).toEqual({ canBack: false, canForward: false })
    recordNavigation("/b")
    expect(getNavHistorySnapshot()).toEqual({ canBack: true, canForward: false })
    // Repeating the current path is a no-op.
    recordNavigation("/b")
    expect(getNavHistorySnapshot()).toEqual({ canBack: true, canForward: false })
  })

  it("navigates back and forward, pushing the target path each time", () => {
    const router = makeRouter()
    recordNavigation("/a")
    recordNavigation("/b")
    recordNavigation("/c")

    navigateBack(router)
    expect(router.push).toHaveBeenLastCalledWith("/b")
    expect(getNavHistorySnapshot()).toEqual({ canBack: true, canForward: true })

    navigateBack(router)
    expect(router.push).toHaveBeenLastCalledWith("/a")
    expect(getNavHistorySnapshot()).toEqual({ canBack: false, canForward: true })

    navigateForward(router)
    expect(router.push).toHaveBeenLastCalledWith("/b")
    expect(getNavHistorySnapshot()).toEqual({ canBack: true, canForward: true })
  })

  it("treats the push produced by an arrow as internal (no duplicate entry)", () => {
    const router = makeRouter()
    recordNavigation("/a")
    recordNavigation("/b")
    navigateBack(router) // index → /a, internalNav set

    // Simulate the pathname effect firing with the path the arrow navigated to.
    recordNavigation("/a")
    // Forward must still be possible — /b was not truncated.
    expect(getNavHistorySnapshot()).toEqual({ canBack: false, canForward: true })
  })

  it("truncates the forward branch when navigating to a new path after going back", () => {
    const router = makeRouter()
    recordNavigation("/a")
    recordNavigation("/b")
    recordNavigation("/c")
    navigateBack(router) // at /b, forward = /c
    expect(getNavHistorySnapshot().canForward).toBe(true)
    // The router push fires the pathname effect for the path we landed on,
    // which consumes the internal-nav flag.
    recordNavigation("/b")

    // A fresh navigation drops the /c forward entry.
    recordNavigation("/d")
    expect(getNavHistorySnapshot()).toEqual({ canBack: true, canForward: false })
  })

  it("ignores back/forward at the history bounds", () => {
    const router = makeRouter()
    navigateBack(router)
    navigateForward(router)
    expect(router.push).not.toHaveBeenCalled()

    recordNavigation("/only")
    navigateForward(router)
    navigateBack(router)
    expect(router.push).not.toHaveBeenCalled()
  })

  it("re-renders subscribers via useNavHistory when state changes", () => {
    const { result } = renderHook(() => useNavHistory())
    expect(result.current).toEqual({ canBack: false, canForward: false })

    act(() => {
      recordNavigation("/a")
      recordNavigation("/b")
    })
    expect(result.current).toEqual({ canBack: true, canForward: false })
  })
})
