import * as sdk from "./decision-provider"
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  PluginDecisionProviderDef,
  PluginDecisionProviderInput,
  PluginDecisionRegistration,
  PluginDecisionsAPI,
} from "./decision-provider"

describe("plugin-sdk api/decision-provider", () => {
  it("exposes the authoring helper and pure request helpers", () => {
    expect(typeof sdk.defineDecisionProvider).toBe("function")
    expect(typeof sdk.validateDecisionRequest).toBe("function")
    expect(typeof sdk.validateDecisionQuestions).toBe("function")
    expect(sdk.scoreFraction({ score: 2, levels: 5 })).toBeCloseTo(0.5)
    expect(sdk.MAX_CHOICE_OPTIONS).toBe(255)
    expect(sdk.DECISION_ERROR_KINDS).toContain("provider_unavailable")
  })

  it("lets a provider validate a request before its forward pass", () => {
    const request: DecisionRequest = {
      state: { post: "hi" },
      questions: { spam: { type: "noul", instructions: "Is `post` spam?" } },
    }
    expect(sdk.validateDecisionRequest(request)).toEqual({ ok: true, request })
    expect(sdk.validateDecisionQuestions({})).toMatch(/non-empty/)
  })

  it("re-exports the contribution and API types", () => {
    const assertTypes = <
      _T extends
        | PluginDecisionProviderDef
        | PluginDecisionProviderInput
        | PluginDecisionRegistration
        | PluginDecisionsAPI
        | DecisionProvider
        | DecisionResult,
    >() => true
    expect(assertTypes()).toBe(true)
  })
})
