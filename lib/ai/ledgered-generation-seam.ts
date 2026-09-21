/**
 * The host's generation seam for the pure packages (ADR-0188 D27, WP-L2).
 *
 * `@cognia/rag`, `@cognia/web-search` and `@cognia/provider-embedding` make a
 * few LLM generations of their own — query expansion, rerank, grading,
 * grounding, evaluation, contextual retrieval, semantic chunking, the
 * standalone search answer, the Google AI grounded search. A package cannot
 * import the CallLedger, so each of those calls takes an optional `generate`
 * seam (`@cognia/provider-embedding/generation-seam`, and its structural twin in
 * `@cognia/web-search`). This module is where a host gets the seam, and every
 * host that runs one of those calls takes it from here — which is why the
 * baseline of `scripts/gates/check-llm-ledger-boundary.mjs` names this file as
 * those package files' `seam`.
 *
 * The seam reuses the one ledger mechanism renderer utilities already use:
 * each call becomes an `LlmClient` whose `complete` is the package's own
 * `send`, wrapped by `ledgerUtilityCalls`. So:
 *
 *  - Off, or a tripped surface: `ledgeredGenerationSeam` returns `undefined`,
 *    the caller injects nothing, and the package makes its call exactly as it
 *    always has (D37). No Router + Fusion module is loaded.
 *  - On: the call is reserved before it leaves (a session-less utility run),
 *    sent with the reservation's output bound and no hidden retries, and
 *    settled from the usage the provider reported.
 *  - An infrastructure fault in the ledger sends the call on the original path,
 *    unledgered, with the "not ledgered" notice, and feeds the breaker — that is
 *    `ledgerUtilityCalls`' own `runOrdinaryWithFallback` (D38). A refusal is an
 *    answer: it is raised, and the package handles it like any failed call.
 */

import type { GenerationSeam } from "@cognia/provider-embedding/generation-seam"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

import { recordFusionFault } from "@/lib/router-fusion/gate/breaker"
import { toInfrastructureFault } from "@/lib/router-fusion/gate/faults"
import {
  breakerThresholdOf,
  routerFusionGate,
  type RouterFusionGateSettings,
} from "@/lib/router-fusion/gate/feature-gate"
import type { RouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import {
  ledgerUtilityCalls,
  type LedgeredUtilityBinding,
} from "@/lib/router-fusion/gate/utility-ledger"
import { readUsageDelta, type LlmClient, type LlmUsageSnapshot } from "@/lib/twin/distill/llm"

/**
 * Who is calling, for the run list and pricing. The model id comes from each
 * call (the package knows which model it is about to call), and the stage id is
 * appended to `featureId`, e.g. `project-knowledge:rag.hyde`.
 */
export type GenerationSeamBinding = Omit<LedgeredUtilityBinding, "modelId">

export interface LedgeredGenerationSeamInput {
  binding: GenerationSeamBinding
  /** The settings the gate reads; also handed to the ledger so it does not re-read them. */
  settings: RouterFusionGateSettings | null | undefined
  /** Test seam, forwarded to `ledgerUtilityCalls`. */
  loadHost?: () => Promise<RouterFusionHost>
}

/**
 * The seam a host injects into a package generation, or `undefined` when the
 * binding's surface is not on (the caller then injects nothing at all).
 */
export function ledgeredGenerationSeam(
  input: LedgeredGenerationSeamInput
): GenerationSeam | undefined {
  if (routerFusionGate(input.settings, input.binding.surface) !== "on") return undefined
  return (request, send) => {
    const usage: LlmUsageSnapshot = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    // One client per call: the package's own request is the only thing it can send.
    const inner: LlmClient = {
      provider: input.binding.providerId,
      model: request.modelId,
      async complete(_prompt, options) {
        const result = await send({
          ...(options?.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
          ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
        })
        // The same additive convention `createLlmClient` keeps, so the ledger
        // reads this call's delta exactly as it reads a renderer utility's.
        const delta = readUsageDelta(
          result.usage as Record<string, unknown> | undefined,
          result.providerMetadata as Record<string, unknown> | undefined
        )
        usage.inputTokens += delta.inputTokens
        usage.outputTokens += delta.outputTokens
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + delta.cacheReadTokens
        usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + delta.cacheCreationTokens
        usage.totalTokens = usage.inputTokens + usage.outputTokens
        return result.text
      },
      getUsageSnapshot: () => ({ ...usage }),
    }
    const client = ledgerUtilityCalls(inner, {
      binding: {
        ...input.binding,
        featureId: `${input.binding.featureId}:${request.stage}`,
        modelId: request.modelId,
      },
      settings: input.settings,
      ...(input.loadHost ? { loadHost: input.loadHost } : {}),
    })
    return client.complete(request.prompt, {
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
    })
  }
}

export interface ResolveLedgeredGenerationSeamInput {
  surface: RouterFusionSurface
  settings: RouterFusionGateSettings | null | undefined
  /**
   * The binding, read only once the gate said on — for a caller whose provider
   * id lives in a settings row of its own (the twin's distill LLM).
   */
  resolveBinding: () => Promise<Omit<GenerationSeamBinding, "surface">>
  loadHost?: () => Promise<RouterFusionHost>
}

/**
 * {@link ledgeredGenerationSeam} for a binding that needs a read first. The
 * read is ledger preparation, so a read that faults is an infrastructure fault
 * on ordinary traffic: the call goes out on the original path (no seam), with
 * the same "unledgered" notice, and the breaker counts it (D38).
 *
 * This deliberately does not run the read through `runOrdinaryWithFallback`:
 * that records a breaker success when the step succeeds, and a read that
 * succeeds says nothing about the ledger. Counting it would reset the
 * consecutive-fault count between two failed reservations, and a ledger that
 * kept faulting would never trip its surface. The reservation's own guard (in
 * `ledgerUtilityCalls`) records success and faults for the ledger itself.
 */
export async function resolveLedgeredGenerationSeam(
  input: ResolveLedgeredGenerationSeamInput
): Promise<GenerationSeam | undefined> {
  if (routerFusionGate(input.settings, input.surface) !== "on") return undefined
  let binding: Omit<GenerationSeamBinding, "surface">
  try {
    binding = await input.resolveBinding()
  } catch (error) {
    const fault = toInfrastructureFault(error)
    // A refusal is an answer, never bypassed (none is expected from a read).
    if (!fault) throw error
    recordFusionFault(input.surface, fault.code, breakerThresholdOf(input.settings))
    console.warn(
      "[router-fusion] a package generation called on the original path, unledgered",
      fault
    )
    return undefined
  }
  return ledgeredGenerationSeam({
    binding: { ...binding, surface: input.surface },
    settings: input.settings,
    ...(input.loadHost ? { loadHost: input.loadHost } : {}),
  })
}
