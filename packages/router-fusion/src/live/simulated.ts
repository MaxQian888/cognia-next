/**
 * The Fake Provider side of `--fake` (ADR-0188 D4, EVAL-04).
 *
 * A simulated smoke runs the same cases through the same router, ledger and
 * orchestrator as a live one; only the deployments and the answers are fake.
 * The deployments are the spec's mock registry re-keyed by routing tier
 * (`fakeTierRegistry`), so the prices the ledger books are the mock rate
 * cards; the answers are scripted per logical step, shaped the way each
 * workflow asks for them.
 *
 * Everything that comes out of here is labelled simulated by the report. It
 * says nothing about how a real model would answer, what it would cost, or how
 * long it would take.
 */

import { FakeProvider, type FakeStep } from "../fake/fake-provider"
import { fakeTierRegistry } from "../fake/mock-registry"
import type { RoleCallRequest } from "../workflows/ports"
import type { LiveProviderListing } from "./providers"

/** The provider id simulated deployments carry (`fake::<model>`). */
export const SIMULATED_PROVIDER_ID = "fake"

/** How a simulated report lists its one provider. */
export function simulatedProviderListing(): LiveProviderListing {
  return {
    id: SIMULATED_PROVIDER_ID,
    name: "Fake Provider (simulated)",
    kind: "builtin",
    enabled: true,
    // The Fake Provider needs no key; an empty name renders as "not needed".
    credentialEnv: "",
    credentialFound: true,
    selected: true,
  }
}

export interface SimulatedTier {
  /** The routing tier the built-in actions name (`fast`, `balanced`, `powerful`). */
  alias: string
  modelId: string
  promptPer1M: number
  completionPer1M: number
  contextTokens: number
  maxOutputTokens: number
}

/** One simulated deployment per routing tier, priced by the mock registry's own rate cards. */
export function simulatedTiers(): SimulatedTier[] {
  const registry = fakeTierRegistry()
  const byId = new Map(registry.deployments.map((deployment) => [deployment.id, deployment]))
  const cards = new Map(registry.rate_cards.map((card) => [card.id, card]))
  return Object.entries(registry.aliases).map(([alias, [deploymentId]]) => {
    const deployment = byId.get(deploymentId)
    const card = deployment?.rateCardId ? cards.get(deployment.rateCardId) : undefined
    if (!deployment || !card) {
      throw new Error(`the mock registry has no priced deployment for tier ${alias}`)
    }
    return {
      alias,
      modelId: deployment.modelRevision,
      promptPer1M: Number(card.ordinary_input_per_million),
      completionPer1M: Number(card.output_per_million),
      contextTokens: deployment.contextLimit,
      maxOutputTokens: deployment.maxOutputTokens,
    }
  })
}

/** The cascade case's answer (`CASCADE_CASE_SCHEMA`). */
export const SIMULATED_CASCADE_ANSWER = { country: "France", capital: "Paris" } as const

const PANEL_UNCERTAINTY = "no evidence tool was available to this panel"

/**
 * The scripted answer for one call, by the logical step the workflow named.
 * A step this script does not know gets a visible "unscripted" text, which
 * the workflow then treats like any wrong answer — never a silent pass.
 */
export function simulatedStep(request: RoleCallRequest): FakeStep {
  const step = request.logicalStepId
  if (step.startsWith("direct:")) {
    return {
      kind: "text",
      text: "A unit test checks one small piece of code in isolation against an expected result.",
    }
  }
  if (step.startsWith("cascade:")) {
    return request.jsonSchema
      ? { kind: "json", value: SIMULATED_CASCADE_ANSWER }
      : { kind: "text", text: "Paris is the capital of France." }
  }
  if (step.startsWith("panel:member:")) {
    const role = step.split(":")[2] ?? "member"
    return {
      kind: "json",
      value: {
        answer: `(${role}) Review catches defects early, and it spreads knowledge of the code across the team.`,
        claims: [
          { claim_id: "c1", text: "Code review catches defects early.", evidence_refs: [] },
          { claim_id: "c2", text: "Code review spreads knowledge of the code.", evidence_refs: [] },
        ],
        assumptions: [],
        open_questions: [],
      },
    }
  }
  if (step.startsWith("panel:judge:")) {
    return {
      kind: "json",
      value: {
        supported_claim_ids: [],
        rejected_claim_ids: [],
        contradictions: [],
        missing_requirements: [],
        verification_requests: [],
        ready_to_synthesize: true,
      },
    }
  }
  if (step === "panel:synthesis") {
    return {
      kind: "json",
      value: {
        answer:
          "Code review is commonly credited with catching defects early and spreading knowledge of the code, but no evidence was checked here.",
        used_claim_ids: [],
        uncertainties: [PANEL_UNCERTAINTY],
        citations: [],
      },
    }
  }
  if (step === "panel:final_check") {
    return {
      kind: "json",
      value: {
        status: "passed",
        new_unsupported_claims: [],
        missing_requirements: [],
        lost_citations: [],
      },
    }
  }
  return { kind: "text", text: `unscripted simulated step ${step}` }
}

/** A Fake Provider answering every case's steps. */
export function simulatedProvider(): FakeProvider {
  return new FakeProvider((request) => simulatedStep(request))
}
