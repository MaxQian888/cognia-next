import { defineLimitsSource } from "./define-limits-source"

describe("defineLimitsSource", () => {
  it("returns the source definition unchanged (pure pass-through)", () => {
    const fetch = jest.fn(async () => null)
    const def = defineLimitsSource({
      id: "p:prov-limits",
      key: "prov",
      name: "Provider limits",
      matches: () => true,
      fetch,
    })
    expect(def).toMatchObject({ id: "p:prov-limits", key: "prov" })
    expect(def.fetch).toBe(fetch)
  })
})
