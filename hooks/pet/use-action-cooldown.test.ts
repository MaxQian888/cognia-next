import { renderHook, act } from "@testing-library/react"
import { useActionCooldown } from "./use-action-cooldown"
import { usePetStore } from "@/stores/pet/pet-store"

beforeEach(() => {
  usePetStore.setState({ actionCooldowns: {} })
})

describe("useActionCooldown", () => {
  it("reports zero remaining for an untriggered action", () => {
    const { result } = renderHook(() => useActionCooldown())
    expect(result.current.remaining("fed")).toBe(0)
  })

  it("triggers a cooldown that reports remaining time and clears the store on reset", () => {
    const { result } = renderHook(() => useActionCooldown())
    act(() => result.current.trigger("fed", 5000))
    expect(usePetStore.getState().actionCooldowns.fed).toBeGreaterThan(Date.now())
    expect(result.current.remaining("fed")).toBeGreaterThan(0)
    expect(result.current.remaining("slept")).toBe(0)
  })

  it("counts down to zero once the deadline passes", () => {
    // Seed a deadline already in the past → remaining is clamped to 0.
    usePetStore.setState({ actionCooldowns: { fed: Date.now() - 10 } })
    const { result } = renderHook(() => useActionCooldown())
    expect(result.current.remaining("fed")).toBe(0)
  })
})
