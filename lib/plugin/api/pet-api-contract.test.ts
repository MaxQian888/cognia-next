import {
  MAX_COINS_PER_EMIT,
  MAX_XP_PER_EMIT,
  PLUGIN_EMITTABLE_PET_EVENT_KINDS,
  PetCooldownError,
  PetEventKindNotAllowedError,
  PetItemKindMismatchError,
  PetItemNotOwnedError,
} from "./pet-api-contract"
import {
  MAX_COINS_PER_REWARD,
  MAX_XP_PER_REWARD,
  PET_REWARDABLE_KINDS,
} from "@/lib/pet/access/limits"

describe("plugin pet API contract", () => {
  it("publishes exactly the gate's rewardable kinds and per-call limits", () => {
    expect(PLUGIN_EMITTABLE_PET_EVENT_KINDS).toEqual(PET_REWARDABLE_KINDS)
    expect(MAX_XP_PER_EMIT).toBe(MAX_XP_PER_REWARD)
    expect(MAX_COINS_PER_EMIT).toBe(MAX_COINS_PER_REWARD)
  })

  it("names the allowed kinds when refusing one", () => {
    const err = new PetEventKindNotAllowedError("levelUp")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("PetEventKindNotAllowedError")
    expect(err.message).toContain('"levelUp"')
    expect(err.message).toContain("pluginReward")
  })

  it("identifies an unowned item", () => {
    const err = new PetItemNotOwnedError("royal-feast")
    expect(err.name).toBe("PetItemNotOwnedError")
    expect(err.message).toContain("royal-feast")
  })

  it("carries the item, the attempted action and the item's own action on a mismatch", () => {
    const err = new PetItemKindMismatchError("berry", "petted", "fed")
    expect(err.name).toBe("PetItemKindMismatchError")
    expect(err).toMatchObject({ itemId: "berry", kind: "petted", itemKind: "fed" })
    expect(err.message).toContain("not spent")
    expect(new PetItemKindMismatchError("odd", "fed", undefined).message).toContain("nothing")
  })

  it("carries a retry delay on a cooldown and says nothing was spent", () => {
    const err = new PetCooldownError("treated", 9001)
    expect(err.name).toBe("PetCooldownError")
    expect(err).toMatchObject({ kind: "treated", retryAfterMs: 9001 })
    expect(err.message).toContain("10s")
    expect(err.message).toContain("nothing was spent")
  })
})
