/**
 * What inbound binary media is allowed to reach a model.
 *
 * An inbound image, voice note, video or document arrives as bytes. Handing
 * those bytes to a cloud model uploads someone's photo, ID scan or contract to
 * a third party because a bot happened to be in the chat — a decision nobody
 * made explicitly. The default here is therefore `local_extract_only`: the
 * bytes stay on the device, and only text a LOCAL extractor produced (OCR,
 * transcription) may become model input.
 *
 * Three rules follow, and each closes a hole the earlier code left open:
 *
 *   1. **Locally-derived text is re-gated for PII.** OCR of a photographed
 *      form is not equivalent to typed chat text — it routinely contains the
 *      exact identifiers the redaction gate exists to catch. Extracted text
 *      that fails the gate is dropped, not sent.
 *   2. **Blocking is not silence.** A withheld attachment is recorded
 *      (`inbound.media_model_blocked`) and the model is told something arrived
 *      that it cannot see, so it can ask rather than answer as if the message
 *      were empty.
 *   3. **Text permission is not media permission.** Sending raw bytes needs an
 *      explicit, revocable, provider-scoped grant on the conversation. A bot
 *      configured to talk to a cloud model does not thereby gain the right to
 *      upload the pictures people send it.
 *
 * The decision is taken once, in the bus, and stamped on the in-memory event.
 * `runtime.ts:inboundEventToSendContent` is the single place inbound bytes can
 * become model content, and it honours the stamp. Bytes are deliberately NOT
 * stripped from the event: the Inbox still renders the image locally, which
 * was never the problem.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import type { MediaModelPolicy } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

/** Why a segment's content was withheld from the model. */
export type MediaModelBlockReason =
  /** Policy is `local_extract_only` and no local extractor produced text. */
  | "no_local_text"
  /** Locally-derived text existed but did not clear the PII gate. */
  | "pii_gate"
  /** A grant exists, but not for the provider this turn will run on. */
  | "provider_not_granted"

export interface MediaModelBlock {
  segmentType: MessageSegment["type"]
  reason: MediaModelBlockReason
}

export interface MediaModelDecision {
  policy: MediaModelPolicy
  /** Segments whose content the model will not see, and why. */
  blocked: MediaModelBlock[]
}

/** Segment kinds that carry binary media rather than text. */
const MEDIA_TYPES = new Set<MessageSegment["type"]>(["image", "voice", "video", "file"])

export function isMediaSegment(seg: MessageSegment): boolean {
  return MEDIA_TYPES.has(seg.type)
}

/** The locally-derived text a segment carries, if any. */
function localText(seg: MessageSegment): string | undefined {
  if (seg.type === "image" || seg.type === "file") return seg.ocrText
  if (seg.type === "voice") return seg.transcript
  return undefined
}

function clearLocalText(seg: MessageSegment): void {
  if (seg.type === "image" || seg.type === "file") delete seg.ocrText
  else if (seg.type === "voice") delete seg.transcript
}

export interface ResolveMediaPolicyInput {
  /** Bot-wide default. Absent is treated as the safe value, never the loose one. */
  adapter: { mediaModelPolicy?: MediaModelPolicy }
  /** Conversation override carrying the explicit grant, when one exists. */
  override?: {
    mediaModelGrant?: MediaModelGrant
    providerOverride?: string
  } | null
  /** Provider the turn will run on; falls back to the adapter default. */
  adapterDefaultProvider?: string
  now?: number
}

/**
 * A conversation-scoped, revocable permission to send raw binary media to a
 * model.
 *
 * Provider-scoped on purpose: "you may show this to the local vision model I
 * run on this machine" and "you may upload this to a third party" are
 * different decisions, and one grant must not silently become the other when
 * the conversation's provider changes.
 */
export interface MediaModelGrant {
  /** The only value that grants anything; anything else is inert. */
  policy: "allow_cloud_binary"
  /** Provider ids the grant covers. Empty means the grant grants nothing. */
  providers: string[]
  grantedAt: number
  /** Optional expiry; an expired grant is inert without needing a sweep. */
  expiresAt?: number
}

/**
 * Resolve the effective policy for one turn.
 *
 * Every ambiguity resolves to `local_extract_only`: a missing policy, a
 * missing grant, an expired grant, a grant with no providers, or a grant that
 * does not name the provider this turn will actually use.
 */
export function resolveMediaModelPolicy(input: ResolveMediaPolicyInput): MediaModelPolicy {
  const base = input.adapter.mediaModelPolicy ?? "local_extract_only"
  const grant = input.override?.mediaModelGrant
  if (!grant || grant.policy !== "allow_cloud_binary") return base
  const now = input.now ?? Date.now()
  if (typeof grant.expiresAt === "number" && grant.expiresAt <= now) return base
  if (!Array.isArray(grant.providers) || grant.providers.length === 0) return base

  // Same precedence the effective-config resolver uses, so the grant is checked
  // against the provider the turn will really run on.
  const provider = input.override?.providerOverride ?? input.adapterDefaultProvider
  if (!provider || !grant.providers.includes(provider)) return base
  return "allow_cloud_binary"
}

export interface MediaGateDeps {
  /** Injected for tests; production uses the shared redaction gate. */
  isPiiSafe?: (text: string) => boolean
}

/**
 * Apply `policy` to `event`'s media segments.
 *
 * Mutates the event in two ways only: it stamps the resolved policy (so the
 * prompt builder cannot reach a different conclusion), and it removes
 * locally-derived text that failed the PII gate. Binary payloads are left
 * alone — they are still wanted for local rendering.
 */
export function applyMediaModelGate(
  event: { segments: MessageSegment[]; mediaModelPolicy?: MediaModelPolicy },
  policy: MediaModelPolicy,
  deps: MediaGateDeps = {}
): MediaModelDecision {
  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
  const blocked: MediaModelBlock[] = []
  event.mediaModelPolicy = policy

  for (const seg of event.segments) {
    if (!isMediaSegment(seg)) continue

    const text = localText(seg)
    if (typeof text === "string" && text.length > 0) {
      // OCR of a photographed document is not equivalent to typed chat text.
      if (!isPiiSafe(text)) {
        clearLocalText(seg)
        blocked.push({ segmentType: seg.type, reason: "pii_gate" })
      }
      continue
    }

    // No local text. Under `allow_cloud_binary` the bytes themselves go, so
    // nothing is withheld and there is nothing to report.
    if (policy === "allow_cloud_binary") continue
    blocked.push({ segmentType: seg.type, reason: "no_local_text" })
  }

  return { policy, blocked }
}
