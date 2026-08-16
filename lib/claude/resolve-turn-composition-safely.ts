/**
 * Composition resolution for the send path, with the send path's error policy
 * (ADR-0117).
 *
 * `build-options.ts` never fails a send over spec stamping, so this wrapper
 * swallows and returns `undefined` — which the sidecar reads as `native`, the
 * pre-composition behaviour. That is the safe direction: the failure mode of a
 * missing composition is "the model gets the tool surface it always got", not
 * "the model gets a surface nobody authorised".
 *
 * Kept out of `build-options.ts` itself so the degradation is directly
 * testable; that file is 3,700 lines and this decision is worth asserting on
 * its own.
 */

import {
  resolveTurnComposition,
  toolSurfaceFromNames,
} from "@/lib/agent/composition/resolve-turn-composition"
import type { ResolvedAgentCompositionV1 } from "@cognia/agent-config-types/agent-composition"

export interface SafeTurnCompositionInput {
  sessionId?: string
  systemPrompt?: string
  /** `SendOptions.allowedTools` — names only; schemas are not assembled here. */
  toolNames?: readonly string[]
  executionFingerprint?: string
}

export async function resolveTurnCompositionSafely(
  input: SafeTurnCompositionInput
): Promise<ResolvedAgentCompositionV1 | undefined> {
  try {
    return await resolveTurnComposition({
      sessionId: input.sessionId,
      systemPrompt: input.systemPrompt,
      tools: toolSurfaceFromNames(input.toolNames ?? []),
      executionFingerprint: input.executionFingerprint,
    })
  } catch {
    return undefined
  }
}
