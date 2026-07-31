import { defineBalanceAdapter } from "./define-balance-adapter"

describe("defineBalanceAdapter", () => {
  it("returns the adapter definition unchanged (pure pass-through)", () => {
    const matches = jest.fn(() => true)
    const def = defineBalanceAdapter({
      id: "p:prov-balance",
      key: "prov",
      name: "Provider balance",
      matches,
      request: () => ({}) as never,
      parse: () => ({}) as never,
    })
    expect(def).toMatchObject({ id: "p:prov-balance", key: "prov" })
    expect(def.matches).toBe(matches)
  })
})
