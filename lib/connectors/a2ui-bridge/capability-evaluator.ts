/**
 * Compare an A2UI surface against an adapter's capability matrix and
 * report which components are renderable natively, which will fall back
 * to `plainTextMirror`, and which are flat-out unsupported.
 *
 * Consumers:
 *
 *   - `lib/claude/build-options.ts:resolveSendOptions` calls this when
 *     building the capability-aware system prompt so the assistant knows
 *     which kinds will degrade on the current channel.
 *   - Adapter mappers can call it to short-circuit native rendering when
 *     the surface contains an `"unsupported"` component (they go straight
 *     to `plainTextMirror`).
 *   - The Inbox panel uses it to show a "this card will not render in
 *     {platform}" hint next to outbound drafts.
 */

import type {
  A2UICapabilityMatrix,
  A2UIComponentKind,
  A2UIComponentSupport,
} from "@/types/connectors/capability"
import { A2UI_COMPONENT_KINDS, componentKindsByLevel } from "@/types/connectors/capability"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { walkA2UISurface } from "@/lib/connectors/adapters/_shared/a2ui-mapper"

export interface CapabilityEvaluation {
  /** Component kinds present in the surface that the platform renders natively. */
  native: A2UIComponentKind[]
  /** Present kinds that will degrade to plainTextMirror but are still safe to send. */
  fallback: A2UIComponentKind[]
  /** Present kinds the adapter refuses; the assistant should avoid these. */
  unsupported: A2UIComponentKind[]
  /** Overall verdict — `"unsupported"` if any unsupported kind is present. */
  worstCase: A2UIComponentSupport
}

/**
 * Evaluate which component kinds are present in `surface` and look each
 * one up in `matrix`. Unknown component kinds (custom plugins / future
 * additions) are treated as `"fallback"` because the renderer guarantees
 * a best-effort `plainTextMirror`.
 */
export function evaluateSurfaceAgainstCapability(
  surface: A2UISegmentContent,
  matrix: A2UICapabilityMatrix
): CapabilityEvaluation {
  const presentKinds = new Set<A2UIComponentKind | string>()
  walkA2UISurface(surface, (node) => {
    presentKinds.add(node.component)
  })

  const native: A2UIComponentKind[] = []
  const fallback: A2UIComponentKind[] = []
  const unsupported: A2UIComponentKind[] = []
  let worstCase: A2UIComponentSupport = "native"

  for (const kind of presentKinds) {
    if (!isKnownKind(kind)) {
      // Unknown — bucket as fallback so we don't accidentally claim it
      // unsupported when the renderer can still emit a text mirror.
      continue
    }
    const support = matrix[kind] ?? "fallback"
    if (support === "native") native.push(kind)
    else if (support === "fallback") {
      fallback.push(kind)
      if (worstCase === "native") worstCase = "fallback"
    } else {
      unsupported.push(kind)
      worstCase = "unsupported"
    }
  }

  return { native, fallback, unsupported, worstCase }
}

/**
 * Build the capability summary the build-options resolver appends to the
 * system prompt. Concise (single paragraph, three bullets) so it fits
 * into the existing prompt budget without dominating.
 */
export function buildCapabilityPromptSection(
  platform: string,
  matrix: A2UICapabilityMatrix
): string {
  const native = componentKindsByLevel(matrix, "native")
  const fallback = componentKindsByLevel(matrix, "fallback")
  const unsupported = componentKindsByLevel(matrix, "unsupported")

  const lines: string[] = [
    `This conversation is delivered via ${platform}. The platform supports a limited A2UI subset:`,
  ]
  if (native.length > 0) {
    lines.push(`- Renders natively: ${native.join(", ")}.`)
  }
  if (fallback.length > 0) {
    lines.push(
      `- Degrades to plain text on this channel: ${fallback.join(", ")} (avoid when fidelity matters).`
    )
  }
  if (unsupported.length > 0) {
    lines.push(`- NOT supported — do not emit: ${unsupported.join(", ")}.`)
  }
  return lines.join("\n")
}

function isKnownKind(kind: string): kind is A2UIComponentKind {
  return (A2UI_COMPONENT_KINDS as readonly string[]).includes(kind)
}
