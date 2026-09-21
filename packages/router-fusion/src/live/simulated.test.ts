import { fakeTierRegistry } from "../fake/mock-registry"
import { verifySchemaFixture } from "../verify/text-verifiers"
import type { RoleCallRequest } from "../workflows/ports"
import { CASCADE_CASE_SCHEMA } from "./cases"
import {
  SIMULATED_CASCADE_ANSWER,
  SIMULATED_PROVIDER_ID,
  simulatedProvider,
  simulatedProviderListing,
  simulatedStep,
  simulatedTiers,
} from "./simulated"

function request(logicalStepId: string, jsonSchema?: Record<string, unknown>): RoleCallRequest {
  return {
    runId: "run-1",
    logicalStepId,
    attemptId: `attempt:${logicalStepId}`,
    role: "role",
    deploymentId: "fake::mock/economy-v1",
    messages: [{ role: "user", content: "question" }],
    maxOutputTokens: 256,
    toolPolicyId: null,
    ...(jsonSchema ? { jsonSchema } : {}),
  }
}

describe("simulated tiers", () => {
  it("mirrors the mock registry: one priced deployment per routing tier", () => {
    const tiers = simulatedTiers()
    expect(tiers.map((tier) => tier.alias).sort()).toEqual(["balanced", "fast", "powerful"])
    const registry = fakeTierRegistry()
    for (const tier of tiers) {
      const deployment = registry.deployments.find(
        (entry) => entry.id === registry.aliases[tier.alias][0]
      )!
      expect(tier.modelId).toBe(deployment.modelRevision)
      const card = registry.rate_cards.find((entry) => entry.id === deployment.rateCardId)!
      expect(tier.promptPer1M).toBe(Number(card.ordinary_input_per_million))
      expect(tier.completionPer1M).toBe(Number(card.output_per_million))
    }
    // The panel's members must sit on different model revisions.
    expect(new Set(tiers.map((tier) => tier.modelId)).size).toBe(3)
  })

  it("lists its one provider as needing no key", () => {
    expect(simulatedProviderListing()).toMatchObject({
      id: SIMULATED_PROVIDER_ID,
      credentialEnv: "",
      selected: true,
    })
  })
})

describe("simulatedStep", () => {
  it("answers the cascade case with JSON its schema accepts", () => {
    expect(simulatedStep(request("cascade:cheap", CASCADE_CASE_SCHEMA))).toEqual({
      kind: "json",
      value: SIMULATED_CASCADE_ANSWER,
    })
    expect(
      verifySchemaFixture({
        reportId: "r",
        text: JSON.stringify(SIMULATED_CASCADE_ANSWER),
        schema: CASCADE_CASE_SCHEMA,
      }).status
    ).toBe("passed")
  })

  it("shapes each panel step the way the panel asks for it", () => {
    const member = simulatedStep(request("panel:member:panel_a:1"))
    expect(member).toMatchObject({ kind: "json", value: { claims: expect.any(Array) } })
    expect(simulatedStep(request("panel:judge:1"))).toMatchObject({
      value: { supported_claim_ids: [], ready_to_synthesize: true },
    })
    expect(simulatedStep(request("panel:synthesis"))).toMatchObject({
      value: { used_claim_ids: [], citations: [] },
    })
    expect(simulatedStep(request("panel:final_check"))).toMatchObject({
      value: { status: "passed" },
    })
  })

  it("answers a direct step with text and makes an unknown step visibly unscripted", () => {
    expect(simulatedStep(request("direct:solver"))).toMatchObject({ kind: "text" })
    expect(simulatedStep(request("delegate:plan"))).toEqual({
      kind: "text",
      text: "unscripted simulated step delegate:plan",
    })
  })

  it("is served by a Fake Provider whose request ids are marked mock", async () => {
    const response = await simulatedProvider().call(
      request("direct:solver"),
      new AbortController().signal
    )
    expect(response).toMatchObject({
      outcome: "ok",
      providerRequestId: "mock:attempt:direct:solver",
    })
  })
})
