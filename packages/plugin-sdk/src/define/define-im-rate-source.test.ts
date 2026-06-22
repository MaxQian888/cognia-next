import { defineImRateSource } from "./define-im-rate-source"

describe("defineImRateSource", () => {
  it("returns the source definition unchanged (pure pass-through)", () => {
    const evaluate = jest.fn(() => ({ allow: false, reason: "quiet hours" }))
    const def = defineImRateSource({
      id: "p:quiet",
      key: "quiet",
      name: "Quiet hours",
      matches: () => true,
      evaluate: evaluate as never,
    })
    expect(def).toMatchObject({ id: "p:quiet", key: "quiet" })
    expect(def.evaluate).toBe(evaluate)
  })
})
