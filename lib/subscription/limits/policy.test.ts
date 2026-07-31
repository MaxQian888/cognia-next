import { isLimitsQueryEnabled, limitsQueryAccountKey, setLimitsQueryEnabled } from "./policy"

describe("limits query policy", () => {
  it("requires an exact account opt-in", () => {
    const enabled = [limitsQueryAccountKey("codex", "work")]

    expect(isLimitsQueryEnabled(enabled, "codex", "work")).toBe(true)
    expect(isLimitsQueryEnabled(enabled, "codex", "personal")).toBe(false)
    expect(isLimitsQueryEnabled(undefined, "codex", "work")).toBe(false)
  })

  it("adds and removes account keys idempotently", () => {
    const once = setLimitsQueryEnabled([], "opencode", "relay:1", true)
    const twice = setLimitsQueryEnabled(once, "opencode", "relay:1", true)

    expect(once).toEqual(["opencode:relay%3A1"])
    expect(twice).toEqual(once)
    expect(setLimitsQueryEnabled(twice, "opencode", "relay:1", false)).toEqual([])
  })
})
