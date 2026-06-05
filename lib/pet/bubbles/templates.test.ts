import { pickBubbleKey, pickIdleBubbleKey } from "./templates"
import type { PetEventKind, PetMood } from "@/types/pet"

describe("pickBubbleKey", () => {
  it("returns a stable key for a given kind+seed", () => {
    expect(pickBubbleKey("fed", 7)).toBe(pickBubbleKey("fed", 7))
    expect(pickBubbleKey("fed", 0)).toMatch(/^bubbles\.fed\.\d+$/)
  })

  it("returns null for silent kinds", () => {
    expect(pickBubbleKey("idle", 1)).toBeNull()
    expect(pickBubbleKey("teamRun", 1)).toBeNull()
  })

  it("keeps the index within the variant count and handles negative seeds", () => {
    for (let seed = -50; seed < 50; seed++) {
      const key = pickBubbleKey("success", seed)
      expect(key).toMatch(/^bubbles\.success\.[0-2]$/)
    }
  })

  it("covers every authored kind", () => {
    const kinds: PetEventKind[] = [
      "thinking",
      "waiting",
      "review",
      "success",
      "error",
      "goalComplete",
      "levelUp",
      "evolved",
      "fed",
      "played",
      "petted",
      "hatched",
      "greeting",
      "inboundMessage",
      "achievementUnlocked",
    ]
    for (const k of kinds) expect(pickBubbleKey(k, 3)).not.toBeNull()
  })

  it("keeps achievementUnlocked within its variant pool", () => {
    for (let seed = 0; seed < 10; seed++) {
      expect(pickBubbleKey("achievementUnlocked", seed)).toMatch(
        /^bubbles\.achievementUnlocked\.[0-1]$/
      )
    }
  })
})

describe("pickIdleBubbleKey", () => {
  it("returns a mood-flavoured idle key", () => {
    const moods: PetMood[] = ["content", "happy", "tired", "lonely", "grumpy"]
    for (const m of moods) {
      expect(pickIdleBubbleKey(m, 2)).toMatch(new RegExp(`^bubbles\\.idle\\.${m}\\.\\d+$`))
    }
  })
})
