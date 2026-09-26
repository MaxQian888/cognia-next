/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useNavBadges } from "./use-nav-badges"
import { __resetNavBadgesForTests, setNavBadgeSourceCount } from "@/lib/shell/nav-badges"

beforeEach(() => __resetNavBadgesForTests())

describe("useNavBadges", () => {
  it("reads the live snapshot and follows it", () => {
    const { result } = renderHook(() => useNavBadges())
    expect(result.current).toEqual({})
    act(() => setNavBadgeSourceCount("scheduler.attention", 2))
    expect(result.current).toEqual({ scheduler: 2 })
  })

  it("does not re-render when a source reports the same count again", () => {
    let renders = 0
    renderHook(() => {
      renders += 1
      return useNavBadges()
    })
    act(() => setNavBadgeSourceCount("bots.attention", 1))
    const afterChange = renders
    act(() => setNavBadgeSourceCount("bots.attention", 1))
    expect(renders).toBe(afterChange)
  })
})
