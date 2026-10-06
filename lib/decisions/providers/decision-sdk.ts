/**
 * AI SDK translation behind DecisionProvider. Only the host's redacted request
 * reaches this module; credentials and the platform transport are injected by
 * decisions-http. Consumers and plugin/local providers retain the NOUL contract.
 */
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type {
  Experimental_DecisionModelV4 as DecisionModel,
  Experimental_DecisionModelV4CallOptions as DecisionCallOptions,
} from "@ai-sdk/provider"
import { createGateway, experimental_decide } from "ai"
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import {
  DECISION_HTTP_PRESETS,
  attributionHeaders,
  getDecisionProbabilityKind,
} from "@/lib/decisions/presets"
import type { ResolvedDecisionEndpoint } from "@/lib/decisions/presets"
import type { PlatformFetch } from "@/lib/network/platform-fetch"
import type { DecisionProviderResponse, DecisionRequest } from "@/types/decisions"

type Endpoint = Extract<ResolvedDecisionEndpoint, { ok: true }>

function createModel(endpoint: Endpoint, apiKey: string, fetch: PlatformFetch): DecisionModel {
  const options = { apiKey, baseURL: endpoint.url, fetch }
  switch (DECISION_HTTP_PRESETS[endpoint.preset].adapter) {
    case "typesafe": {
      return createTypeSafeAi({
        ...options,
        headers: attributionHeaders(endpoint.url),
        // Settings historically store the full POST URL, including OpenRouter's
        // alpha path. The SDK appends /systemone; keep the user's exact endpoint.
        fetch: (_url, init) => fetch(endpoint.url, init),
      }).decisionModel(endpoint.model)
    }
    case "openai": {
      return createOpenAI(options).decisionModel(endpoint.model)
    }
    case "anthropic": {
      return createAnthropic(options).decisionModel(endpoint.model)
    }
    case "google": {
      return createGoogleGenerativeAI(options).decisionModel(endpoint.model)
    }
    case "gateway": {
      return createGateway(options).decisionModel(endpoint.model)
    }
    case "legacy":
      throw new Error("Custom legacy endpoints do not use the AI SDK adapter")
  }
}

export async function decideWithSdk(
  request: DecisionRequest,
  endpoint: Endpoint,
  apiKey: string,
  fetch: PlatformFetch,
  signal: AbortSignal
): Promise<DecisionProviderResponse> {
  // runDecision performs redaction; fail closed if an internal direct caller
  // ever attempts to bypass that host boundary.
  if (!hasNoLeakingPiiDeep({ state: request.state, questions: request.questions })) {
    return {
      ok: false,
      error: { kind: "pii", message: "the decision request contains personal data" },
    }
  }
  const model = createModel(endpoint, apiKey, fetch)
  const questions: DecisionCallOptions["questions"] = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [
      id,
      question.type === "noul" ? { ...question, type: "boolean" } : question,
    ])
  )
  const result = await experimental_decide({
    model,
    // Host validation/redaction precedes this call; SDK checks JSON recursively.
    state: request.state as DecisionCallOptions["state"],
    questions,
    abortSignal: signal,
    // Preserve the existing one-attempt policy; the host owns the time budget.
    maxRetries: 0,
  })
  const confidence = result.providerMetadata?.typesafe?.confidence
  return {
    ok: true,
    answers: Object.fromEntries(
      Object.entries(result.answers).map(([id, answer]) => {
        const value =
          confidence && typeof confidence === "object" && !Array.isArray(confidence)
            ? (confidence as Record<string, unknown>)[id]
            : undefined
        return [
          id,
          answer.type === "boolean"
            ? { type: "noul", noul: answer.probability }
            : { ...answer, ...(typeof value === "number" ? { confidence: value } : {}) },
        ]
      })
    ),
    routing: { model: result.response.modelId },
    usage: result.usage,
    rounding: result.rounding,
    probabilityKind: getDecisionProbabilityKind({ preset: endpoint.preset }),
  }
}
