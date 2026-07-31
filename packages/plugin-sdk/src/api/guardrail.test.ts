import * as sdk from "./guardrail"

describe("plugin-sdk: api/guardrail", () => {
  it("re-exports defineGuardrail + the PII output guardrail factory", () => {
    expect(typeof sdk.defineGuardrail).toBe("function")
    expect(typeof sdk.createPiiOutputGuardrail).toBe("function")
  })

  it("defineGuardrail is a typesafe identity function", () => {
    const g = sdk.defineGuardrail({
      id: "no-secrets",
      type: "output",
      run: () => ({ tripwireTriggered: false }),
    })
    expect(g.id).toBe("no-secrets")
    expect(g.type).toBe("output")
  })
})
