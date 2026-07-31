import { defineToolRoute } from "./define-tool-route"

describe("defineToolRoute", () => {
  it("returns the tool route definition unchanged", () => {
    const def = {
      toolName: "search_docs",
      utterances: ["search the docs", "look up docs"],
      threshold: 0.72,
    }

    expect(defineToolRoute(def)).toBe(def)
  })
})
