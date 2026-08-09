/** @jest-environment jsdom */

const getCursor = jest.fn()
jest.mock("@/lib/tauri/pet-window", () => ({
  getPetCursorPosition: () => getCursor(),
}))

import { act, renderHook } from "@testing-library/react"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"
import { usePetLookTarget } from "./use-pet-look-target"

beforeEach(() => {
  jest.useFakeTimers()
  getCursor.mockReset()
  resetPetSkinRuntimeForTests()
})

afterEach(() => jest.useRealTimers())

it("normalizes page-local pointer movement and returns to idle when stale", () => {
  const { result } = renderHook(() =>
    usePetLookTarget({
      enabled: true,
      native: false,
      getBounds: () => ({ left: 100, top: 100, width: 100, height: 100 }),
    })
  )
  act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, clientY: 150 })))
  expect(result.current).toMatchObject({ x: 1, y: 0, source: "window" })
  act(() => jest.advanceTimersByTime(2_001))
  expect(result.current).toBeNull()
})

it("polls the native cursor at no more than 10 Hz", async () => {
  getCursor.mockResolvedValue({ x: 75, y: 50 })
  const { result } = renderHook(() =>
    usePetLookTarget({
      enabled: true,
      native: true,
      getBounds: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    })
  )
  await act(async () => {
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(300)
    await Promise.resolve()
  })
  expect(getCursor.mock.calls.length).toBeLessThanOrEqual(4)
  expect(result.current).toMatchObject({ x: 0.5, y: 0, source: "screen" })
})

it("stops every poll/timer immediately while suspended", () => {
  const { rerender } = renderHook(
    ({ suspended }) =>
      usePetLookTarget({
        enabled: true,
        native: true,
        suspended,
        getBounds: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      }),
    { initialProps: { suspended: false } }
  )
  expect(getPetSkinRuntime().diagnostics().timers).toBe(1)
  rerender({ suspended: true })
  expect(getPetSkinRuntime().diagnostics().timers).toBe(0)
})
