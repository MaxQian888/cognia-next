import { planTicketRemint, type TicketRemintSpec } from "./ticket-remint"

function spec(overrides: Partial<TicketRemintSpec> = {}): TicketRemintSpec {
  return {
    executionFingerprint: "aexf1-abc",
    candidateDeploymentIds: ["dep-a", "dep-b"],
    modelBindings: { primary: "model-alpha", fast: "model-fast" },
    ...overrides,
  }
}

describe("planTicketRemint", () => {
  it("remints for the SAME frozen spec (candidate order is irrelevant)", () => {
    expect(planTicketRemint(spec(), spec({ candidateDeploymentIds: ["dep-b", "dep-a"] }))).toEqual({
      action: "remint",
    })
  })

  it("pauses on fingerprint, candidate-set, or binding drift, naming each mismatch", () => {
    const drifted = planTicketRemint(
      spec(),
      spec({
        executionFingerprint: "aexf1-zzz",
        candidateDeploymentIds: ["dep-a"],
        modelBindings: { primary: "model-alpha", fast: "model-other" },
      })
    )
    expect(drifted).toEqual({
      action: "pause",
      mismatches: ["executionFingerprint", "candidateDeploymentIds", "modelBindings.fast"],
    })
  })

  it("an added powerful binding is drift too (absent vs present)", () => {
    const plan = planTicketRemint(
      spec(),
      spec({ modelBindings: { primary: "model-alpha", fast: "model-fast", powerful: "big" } })
    )
    expect(plan).toEqual({ action: "pause", mismatches: ["modelBindings.powerful"] })
  })
})
