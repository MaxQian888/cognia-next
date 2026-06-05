import {
  ALL_MAPPING_ROWS,
  ONE_SHOT_KEYS,
  STATE_KEYS,
  mappingKeyForOneShot,
  mappingKeyForState,
  overrideKeyFor,
} from "./state-keys"

describe("state-keys", () => {
  it("covers all 11 states and 10 one-shots", () => {
    expect(STATE_KEYS).toHaveLength(11)
    expect(ONE_SHOT_KEYS).toHaveLength(10)
    expect(ALL_MAPPING_ROWS).toHaveLength(21)
  })

  it("namespaces one-shots so 'happy'/'evolving' never collide with the states", () => {
    const keys = ALL_MAPPING_ROWS.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(mappingKeyForState("happy")).toBe("happy")
    expect(mappingKeyForOneShot("happy")).toBe("shot:happy")
  })

  it("overrideKeyFor prefers the active one-shot", () => {
    expect(overrideKeyFor("idle", null)).toBe("idle")
    expect(overrideKeyFor("idle", "wave")).toBe("shot:wave")
    expect(overrideKeyFor("happy", "happy")).toBe("shot:happy")
  })

  it("rows carry the raw id for label lookup", () => {
    const shot = ALL_MAPPING_ROWS.find((r) => r.key === "shot:levelUp")
    expect(shot).toEqual({ key: "shot:levelUp", kind: "oneShot", id: "levelUp" })
  })
})
