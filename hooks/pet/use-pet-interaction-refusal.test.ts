/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import { usePetStore } from "@/stores/pet/pet-store"
import { usePetInteractionRefusal } from "./use-pet-interaction-refusal"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `pet.${key}`,
}))

beforeEach(() => {
  usePetStore.setState({ interactionRefusal: null, bubble: null })
})

describe("usePetInteractionRefusal", () => {
  it("turns a cooldown refusal into a bubble and drains the signal", () => {
    usePetStore.setState({
      interactionRefusal: { kind: "fed", reason: "cooldown", readyAtMs: 5000, at: 1000 },
    })
    renderHook(() => usePetInteractionRefusal(true))
    expect(usePetStore.getState().bubble).toEqual({
      text: "pet.bubbles.refused.cooldown.1",
      origin: "template",
    })
    expect(usePetStore.getState().interactionRefusal).toBeNull()
  })

  it("explains an unhatched egg rather than leaving the button looking broken", () => {
    usePetStore.setState({
      interactionRefusal: { kind: "fed", reason: "not-hatched", at: 2 },
    })
    renderHook(() => usePetInteractionRefusal(true))
    expect(usePetStore.getState().bubble).toEqual({
      text: "pet.bubbles.refused.notHatched.0",
      origin: "template",
    })
  })

  it("picks a variant deterministically so the renderer never calls Math.random", () => {
    const seen = new Set<string>()
    for (const at of [0, 1, 2, 3, 4, 5]) {
      usePetStore.setState({
        interactionRefusal: { kind: "fed", reason: "cooldown", at },
        bubble: null,
      })
      renderHook(() => usePetInteractionRefusal(true))
      seen.add(usePetStore.getState().bubble!.text)
    }
    expect(seen.size).toBe(3)
  })

  it("stays quiet in a window that is not running the pet", () => {
    usePetStore.setState({
      interactionRefusal: { kind: "fed", reason: "cooldown", at: 1000 },
    })
    renderHook(() => usePetInteractionRefusal(false))
    expect(usePetStore.getState().bubble).toBeNull()
    // And the signal survives, so the main window can still render it.
    expect(usePetStore.getState().interactionRefusal).not.toBeNull()
  })

  it("handles each refusal once, so a re-render does not re-bubble", () => {
    usePetStore.setState({
      interactionRefusal: { kind: "fed", reason: "cooldown", at: 1000 },
    })
    const { rerender } = renderHook(() => usePetInteractionRefusal(true))
    usePetStore.setState({ bubble: null })
    rerender()
    expect(usePetStore.getState().bubble).toBeNull()
  })
})
