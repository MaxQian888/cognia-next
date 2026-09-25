import { defineDecisionProvider } from "./define-decision-provider"

describe("defineDecisionProvider", () => {
  it("returns the decision provider contribution unchanged", () => {
    const def = {
      id: "laya-local",
      label: "Laya (local)",
      labelKey: "provider.label",
      backend: "python" as const,
    }

    expect(defineDecisionProvider(def)).toBe(def)
  })
})
