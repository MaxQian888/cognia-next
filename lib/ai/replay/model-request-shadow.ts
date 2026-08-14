/**
 * The shadow `model-request` event (ADR-0118 Phase 0/1).
 *
 * An ordinary run — no recording, no replay — still emits one event per model
 * call carrying only digests. That is what makes prompt and tool-surface drift
 * visible: today the final system prompt and tool list are assembled and thrown
 * away, so a regression in either is invisible until someone notices bad
 * behaviour.
 *
 * The event is digests and references ONLY. Prompt text, messages, tool schemas
 * and responses never ride it — when recording is explicitly enabled they go to
 * the encrypted eval asset store and `surfaceRef` points at them. This is the
 * difference between an observability signal and a data leak, so it is enforced
 * by the shape of the event rather than by convention.
 */

import { digestPrompt, digestToolSurface, digestValue } from "@/lib/agent/composition/digest"
import type { Sha256Hex, ToolSurfaceEntry } from "@/lib/agent/composition/digest"
import { requestDigestPayload } from "@cognia/agent-config-types/model-request-surface"
import type {
  ModelRequestConfigV1,
  ModelRequestPurpose,
} from "@cognia/agent-config-types/model-request-surface"
import type { CanonicalAgentEvent } from "@cognia/agent-config-types/agent-execution"

/**
 * The slice of resolved `SendOptions` a request surface is derived from.
 *
 * Structurally typed rather than importing `SendOptions` so the CLI, the
 * sidecar bridge and the renderer can all hand in whatever they hold without
 * the shadow emitter becoming a reason to widen anyone's imports.
 */
export interface ResolvedRequestShape {
  systemPrompt?: string
  allowedTools?: string[]
  model?: string
  maxTokens?: number
  temperature?: number
}

export interface BuildModelRequestEventInput {
  resolved: ResolvedRequestShape
  provider: string
  purpose: ModelRequestPurpose
  /** Present once the composition for this turn has been frozen. */
  compositionDigest?: string
  executionFingerprint?: string
  /**
   * Normalized messages, when the caller has them.
   *
   * Optional on purpose: `resolveSendOptions` runs before the message list is
   * final, and a prompt/tool digest emitted early is far more useful than no
   * event at all. A surface without messages simply digests an empty list, and
   * the resulting `requestDigest` is a prompt+tools identity rather than a full
   * replay key — which is why the recording proxy, not this, is what produces
   * tapes.
   */
  messages?: unknown[]
  /** Encrypted-asset reference; only set when recording is enabled. */
  surfaceRef?: string
  hash?: Sha256Hex
}

function toolSurface(allowedTools: readonly string[] | undefined): ToolSurfaceEntry[] {
  // Resolved SendOptions carry tool NAMES, not schemas — the schemas live in
  // the SDK. A name-only surface still catches the regressions this event is
  // for: a tool appearing, disappearing, or changing order.
  return (allowedTools ?? []).map((name) => ({ name, schema: null, visibility: "native" as const }))
}

function requestConfig(resolved: ResolvedRequestShape): ModelRequestConfigV1 {
  const config: ModelRequestConfigV1 = {}
  if (typeof resolved.temperature === "number") config.temperature = resolved.temperature
  if (typeof resolved.maxTokens === "number") config.maxOutputTokens = resolved.maxTokens
  return config
}

export async function buildModelRequestEvent(
  input: BuildModelRequestEventInput
): Promise<Extract<CanonicalAgentEvent, { kind: "model-request" }>> {
  const model = input.resolved.model ?? ""
  const [promptDigest, messagesDigest, toolDigest] = await Promise.all([
    digestPrompt(input.resolved.systemPrompt ?? "", input.hash),
    digestValue(input.messages ?? [], input.hash),
    digestToolSurface(toolSurface(input.resolved.allowedTools), input.hash),
  ])

  const requestDigest = await digestValue(
    requestDigestPayload({
      provider: input.provider,
      model,
      purpose: input.purpose,
      config: requestConfig(input.resolved),
      promptDigest,
      messagesDigest,
      toolDigest,
    }),
    input.hash
  )

  return {
    kind: "model-request",
    purpose: input.purpose,
    provider: input.provider,
    model,
    requestDigest,
    promptDigest,
    toolDigest,
    ...(input.compositionDigest ? { compositionDigest: input.compositionDigest } : {}),
    ...(input.executionFingerprint ? { executionFingerprint: input.executionFingerprint } : {}),
    ...(input.surfaceRef ? { surfaceRef: input.surfaceRef } : {}),
  }
}

/**
 * Guard against the one mistake that turns this signal into a leak.
 *
 * Exported so a gate test can assert it over a real event rather than trusting
 * that nobody widened the payload. Anything that is not a digest, an id, an
 * enum or a reference has no business here.
 */
export function containsOnlyDigestsAndRefs(
  event: Extract<CanonicalAgentEvent, { kind: "model-request" }>
): boolean {
  const allowed = new Set([
    "kind",
    "purpose",
    "provider",
    "model",
    "requestDigest",
    "promptDigest",
    "toolDigest",
    "compositionDigest",
    "executionFingerprint",
    "surfaceRef",
  ])
  return Object.keys(event).every((key) => allowed.has(key))
}
