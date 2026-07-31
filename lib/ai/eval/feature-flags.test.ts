import { isEvalLabEnabled } from "./feature-flags"

describe("evaluation lab feature flag", () => {
  it("requires the internal flag and honors the one-release rollback switch", () => {
    expect(isEvalLabEnabled({ NEXT_PUBLIC_EVAL_LAB: "1" })).toBe(true)
    expect(
      isEvalLabEnabled({ NEXT_PUBLIC_EVAL_LAB: "1", NEXT_PUBLIC_EVAL_LEGACY_ROLLBACK: "1" })
    ).toBe(false)
    expect(isEvalLabEnabled({})).toBe(false)
  })
})
