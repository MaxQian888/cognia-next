/** @jest-environment jsdom */
import { renderHook, act } from "@testing-library/react"
import { roomTargetsOf, useRoomTargetStore, useRoomTargets } from "./room-target-store"

beforeEach(() => {
  useRoomTargetStore.setState({ targets: {} })
})

it("keeps a pick per session in pick order, deduplicated, and drops an empty one", () => {
  const { setTargets } = useRoomTargetStore.getState()
  setTargets("s1", ["b", "a", "b", ""])
  setTargets("s2", ["c"])
  expect(roomTargetsOf("s1")).toEqual(["b", "a"])
  expect(roomTargetsOf("s2")).toEqual(["c"])
  expect(roomTargetsOf(null)).toEqual([])
  setTargets("s1", [])
  expect(useRoomTargetStore.getState().targets).toEqual({ s2: ["c"] })
})

it("toggles one member and skips a write that changes nothing", () => {
  const { toggleTarget, setTargets } = useRoomTargetStore.getState()
  toggleTarget("s1", "a")
  toggleTarget("s1", "b")
  toggleTarget("s1", "a")
  expect(roomTargetsOf("s1")).toEqual(["b"])
  const before = useRoomTargetStore.getState().targets
  setTargets("s1", ["b"])
  expect(useRoomTargetStore.getState().targets).toBe(before)
})

it("exposes the pick to React with a stable empty list", () => {
  const { result, rerender } = renderHook(({ id }: { id: string | null }) => useRoomTargets(id), {
    initialProps: { id: "s1" as string | null },
  })
  const empty = result.current
  expect(empty).toEqual([])
  rerender({ id: "s1" })
  expect(result.current).toBe(empty)
  act(() => useRoomTargetStore.getState().setTargets("s1", ["a"]))
  expect(result.current).toEqual(["a"])
  rerender({ id: null })
  expect(result.current).toEqual([])
})
