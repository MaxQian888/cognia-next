/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { useUnreadMarker, useUnreadMarkerStore } from "./unread-marker-store"

beforeEach(() => useUnreadMarkerStore.setState({ markers: {} }))

it("keeps one pointer per session and drops it on null", () => {
  act(() => {
    useUnreadMarkerStore.getState().setMarker("s1", 100)
    useUnreadMarkerStore.getState().setMarker("s2", 200)
  })
  expect(renderHook(() => useUnreadMarker("s1")).result.current).toBe(100)
  expect(renderHook(() => useUnreadMarker("s3")).result.current).toBeNull()
  expect(renderHook(() => useUnreadMarker(null)).result.current).toBeNull()
  act(() => useUnreadMarkerStore.getState().setMarker("s1", null))
  expect(useUnreadMarkerStore.getState().markers).toEqual({ s2: 200 })
})

it("keeps state identity when nothing changes", () => {
  act(() => useUnreadMarkerStore.getState().setMarker("s1", 100))
  const before = useUnreadMarkerStore.getState()
  act(() => {
    useUnreadMarkerStore.getState().setMarker("s1", 100)
    useUnreadMarkerStore.getState().setMarker("s9", null)
  })
  expect(useUnreadMarkerStore.getState()).toBe(before)
})
