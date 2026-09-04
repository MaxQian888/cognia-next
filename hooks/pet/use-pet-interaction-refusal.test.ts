/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import { usePetStore } from "@/stores/pet/pet-store"
import en from "@/i18n/messages/en/pet.json"
import zh from "@/i18n/messages/zh-CN/pet.json"
import { REFUSAL_VARIANTS, usePetInteractionRefusal } from "./use-pet-interaction-refusal"
import type { PetInteractionRefusal } from "@/lib/pet/interaction/gate"

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

describe("the refusal catalogue", () => {
  // `lint:i18n` cannot see a template-literal key, so the hand-kept variant
  // counts and the authored arrays have to be checked against each other here.
  // Drop a zh variant and the pet renders the raw key string with nothing red.

  it("has every variant the hook can ask for, in both locales", () => {
    for (const [reason, count] of Object.entries(REFUSAL_VARIANTS)) {
      const enPool = (en.bubbles.refused as Record<string, string[]>)[reason]
      const zhPool = (zh.bubbles.refused as Record<string, string[]>)[reason]
      expect(enPool).toHaveLength(count)
      expect(zhPool).toHaveLength(count)
    }
  })

  it("covers every reason the controller can produce", () => {
    // The union in `lib/pet/interaction/gate.ts`, restated so a new refusal
    // reason without copy fails here rather than rendering its own key name.
    const produced: PetInteractionRefusal[] = ["cooldown", "not-hatched"]
    for (const reason of produced) {
      const key = reason === "not-hatched" ? "notHatched" : reason
      expect(REFUSAL_VARIANTS[key]).toBeGreaterThan(0)
    }
  })

  it("authors no variant the hook would never reach", () => {
    expect(Object.keys(en.bubbles.refused).sort()).toEqual(Object.keys(REFUSAL_VARIANTS).sort())
  })
})
