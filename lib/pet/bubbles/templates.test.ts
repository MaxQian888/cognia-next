import { pickBubbleKey, pickIdleBubbleKey, pickCustomBubble, SNARK_THRESHOLD } from "./templates"
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
      "slept",
      "cleaned",
      "treated",
      "hatched",
      "greeting",
      "inboundMessage",
      "achievementUnlocked",
      "twinBusy",
      "twinMilestone",
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

  describe("snarky sprinkle", () => {
    const HIGH = { snark: SNARK_THRESHOLD }
    const LOW = { snark: SNARK_THRESHOLD - 1 }

    it("swaps in a snarky key at high snark when the seed lands on the sprinkle", () => {
      // seed % 3 === 0 → snarky pool.
      expect(pickBubbleKey("fed", 9, HIGH)).toMatch(/^bubbles\.snarky\.fed\.[0-1]$/)
      expect(pickBubbleKey("error", 12, HIGH)).toMatch(/^bubbles\.snarky\.error\.[0-1]$/)
    })

    it("keeps the base pool off the sprinkle seeds", () => {
      expect(pickBubbleKey("fed", 10, HIGH)).toMatch(/^bubbles\.fed\.\d+$/)
      expect(pickBubbleKey("fed", 11, HIGH)).toMatch(/^bubbles\.fed\.\d+$/)
    })

    it("stays on the base pool below the threshold or without stats", () => {
      expect(pickBubbleKey("fed", 9, LOW)).toMatch(/^bubbles\.fed\.\d+$/)
      expect(pickBubbleKey("fed", 9)).toMatch(/^bubbles\.fed\.\d+$/)
    })

    it("never snarks on kinds without an authored snarky pool", () => {
      expect(pickBubbleKey("goalComplete", 9, HIGH)).toMatch(/^bubbles\.goalComplete\.\d+$/)
      expect(pickBubbleKey("slept", 9, HIGH)).toMatch(/^bubbles\.slept\.\d+$/)
    })

    it("is deterministic", () => {
      expect(pickBubbleKey("petted", 33, HIGH)).toBe(pickBubbleKey("petted", 33, HIGH))
    })
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

describe("pickCustomBubble", () => {
  it("returns null with no usable phrases", () => {
    expect(pickCustomBubble(undefined, 0)).toBeNull()
    expect(pickCustomBubble([], 0)).toBeNull()
    expect(pickCustomBubble(["   "], 0)).toBeNull()
  })

  it("gates to ~1/3 of seeds and selects deterministically", () => {
    const phrases = ["a", "b"]
    expect(pickCustomBubble(phrases, 0)).toBe("a") // 0%3==0, 0%2==0
    expect(pickCustomBubble(phrases, 3)).toBe("b") // 3%3==0, 3%2==1
    expect(pickCustomBubble(phrases, 1)).toBeNull() // 1%3!=0
    expect(pickCustomBubble(phrases, 2)).toBeNull() // 2%3!=0
    // trims and ignores blanks before indexing
    expect(pickCustomBubble(["  hi  ", ""], 0)).toBe("hi")
  })
})
