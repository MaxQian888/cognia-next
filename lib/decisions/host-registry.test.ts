jest.mock("@/lib/decisions/providers/decisions-http", () => ({
  createDecisionsHttpProvider: () => ({
    id: "builtin:decisions-http",
    label: "Remote decisions endpoint",
    locality: "remote",
    calibrated: true,
    decide: async () => ({ ok: true, answers: {} }),
  }),
}))

import { __resetDecisionRegistryForTesting, getDecisionRegistry } from "./host-registry"

afterEach(() => __resetDecisionRegistryForTesting())

describe("getDecisionRegistry", () => {
  it("is a lazily created singleton seeded with the built-in remote provider", () => {
    const registry = getDecisionRegistry()
    expect(getDecisionRegistry()).toBe(registry)
    expect(registry.list().map((p) => p.id)).toEqual(["builtin:decisions-http"])
  })

  it("starts fresh after a reset", () => {
    const first = getDecisionRegistry()
    __resetDecisionRegistryForTesting()
    expect(getDecisionRegistry()).not.toBe(first)
  })
})
