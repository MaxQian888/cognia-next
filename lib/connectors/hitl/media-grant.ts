/**
 * In-chat consent card for sending this conversation's binary media to a model.
 *
 * `MediaModelGrant` has been the documented way to say "yes, you may upload the
 * pictures people send this bot" since the media gate landed, and nothing could
 * write one — so `mediaModelPolicy: "allow_cloud_binary"` was unreachable and
 * every image, voice note and document was silently withheld forever.
 *
 * ## Why a card and not only a settings form
 *
 * The person who can answer "may this photo go to a cloud model" is the one who
 * just sent it, in the chat where they sent it. A form buried in an override
 * dialog is reachable by an operator who was never there. Both exist — the form
 * is the durable, provider-scoped, expiring grant; this is the moment it is
 * actually a question.
 *
 * ## What it deliberately does NOT do
 *
 * It does not suspend the turn, and the grant does not retroactively unblock the
 * message that triggered it. The media gate runs inside the inbound pipeline,
 * before the turn; awaiting a human there would hold the durable inbound job for
 * as long as the person takes to answer. The card says so, and the grant applies
 * from the next message on. Replaying the blocked message is a separate machine
 * (`bus.runInboundPipeline` replay) with its own dedup questions.
 *
 * The card is asked at most once per conversation per grant-fixable block, so a
 * chat that sends photos all day is not carpeted with consent prompts.
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import { updateConversationConfigSection } from "@/lib/db/conversation-overrides"
import type { MediaModelGrant } from "@/lib/connectors/media-model-gate"

/** Action-id namespaces so the bus can route the press back to a decision. */
export const MEDIA_GRANT_SESSION_PREFIX = "mgs:"
export const MEDIA_GRANT_ALWAYS_PREFIX = "mga:"
export const MEDIA_GRANT_DENY_PREFIX = "mgd:"

export type MediaGrantDecision = "allow_24h" | "allow_always" | "deny"

/** A day, which is what "allow for now" means to the person answering. */
export const MEDIA_GRANT_SESSION_MS = 24 * 60 * 60 * 1_000

export interface MediaGrantSurfaceInput {
  bindingId: string
  /** The provider the grant would cover — the whole point of the question. */
  provider: string
}

/**
 * Pure builder for the consent card.
 *
 * The provider is named in the prompt because that is the decision: "the local
 * vision model on this machine" and "a third party" are not the same answer,
 * and a grant that did not say which one it meant would be consent to nothing
 * in particular.
 */
export function buildMediaGrantSurface(input: MediaGrantSurfaceInput): A2UISegmentContent {
  const session = MEDIA_GRANT_SESSION_PREFIX + input.bindingId
  const always = MEDIA_GRANT_ALWAYS_PREFIX + input.bindingId
  const deny = MEDIA_GRANT_DENY_PREFIX + input.bindingId
  const title = `图片与文件授权 / Send attachments to the model?`
  const prompt =
    `本会话的图片、语音和文件目前不会发送给模型（只有本地识别出的文字会）。` +
    `是否允许发送给 “${input.provider}”？该设置从下一条消息开始生效。 / ` +
    `Images, voice notes and files in this chat are not sent to the model — only text extracted locally is. ` +
    `Allow sending them to "${input.provider}"? Applies from your next message.`
  return {
    components: {
      root: { component: "Card", title, children: ["prompt", "actions"] },
      prompt: { component: "Text", text: prompt },
      actions: { component: "Row", children: ["session", "always", "deny"] },
      session: {
        component: "Button",
        text: "允许 24 小时 / Allow for 24h",
        action: "approve",
        value: session,
      },
      always: {
        component: "Button",
        text: "本会话始终允许 / Always in this chat",
        action: "approve",
        value: always,
      },
      deny: { component: "Button", text: "不允许 / Not now", action: "cancel", value: deny },
    },
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: {
      fallbackText: [
        `# ${title}`,
        prompt,
        "[允许 24 小时 / Allow for 24h] [本会话始终允许 / Always in this chat] [不允许 / Not now]",
        "回复 1 允许 24 小时 / 2 始终允许 / 3 不允许",
      ].join("\n"),
    },
  }
}

/** The grant a decision writes, or `null` for a refusal. */
export function mediaGrantFor(
  decision: MediaGrantDecision,
  provider: string,
  now: number
): MediaModelGrant | null {
  if (decision === "deny") return null
  return {
    policy: "allow_cloud_binary",
    providers: [provider],
    grantedAt: now,
    ...(decision === "allow_24h" ? { expiresAt: now + MEDIA_GRANT_SESSION_MS } : {}),
  }
}

export interface RequestMediaGrantInput {
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  deliveryTarget?: ConversationDeliveryTarget
  /** The provider this conversation's turns resolve to. */
  provider: string
  /**
   * remoteUserId of the person whose message was blocked. Consent belongs to
   * them, so the binding's actor scope names them; absent falls back to
   * operators-only, matching every other approval surface.
   */
  initiatorUserId?: string
  // Injectable for tests.
  enqueue?: typeof enqueueOutbound
  recordBinding?: typeof recordCallbackBinding
  audit?: typeof appendAudit
  now?: number
}

/**
 * Project the consent card into the conversation and record one binding per
 * button. Best-effort: a failure here must never break the inbound pipeline,
 * which has already stored the message and decided its route.
 */
export async function requestMediaGrant(input: RequestMediaGrantInput): Promise<void> {
  const enqueue = input.enqueue ?? enqueueOutbound
  const recordBinding = input.recordBinding ?? recordCallbackBinding
  const audit = input.audit ?? appendAudit
  const now = input.now ?? Date.now()

  const bindingId = newIdempotencyKey().slice(0, 8)
  const surfaceId = `media_grant:${input.conversationKey}:${bindingId}`
  const surface = buildMediaGrantSurface({ bindingId, provider: input.provider })
  const actorScope = input.initiatorUserId
    ? { mode: "initiator" as const, allowedUserIds: [input.initiatorUserId] }
    : { mode: "operators" as const }

  const buttons: Array<{ prefix: string; componentId: string; decision: MediaGrantDecision }> = [
    { prefix: MEDIA_GRANT_SESSION_PREFIX, componentId: "session", decision: "allow_24h" },
    { prefix: MEDIA_GRANT_ALWAYS_PREFIX, componentId: "always", decision: "allow_always" },
    { prefix: MEDIA_GRANT_DENY_PREFIX, componentId: "deny", decision: "deny" },
  ]

  await Promise.all(
    buttons.map((button) =>
      recordBinding({
        adapterId: input.adapterId,
        actionId: button.prefix + bindingId,
        surfaceId,
        componentId: button.componentId,
        conversationKey: input.conversationKey,
        kind: "media_grant",
        payload: { decision: button.decision, provider: input.provider },
        actorScope,
        // Wire-level A2UI verbs, not decisions.
        allowedActions: [button.decision === "deny" ? "cancel" : "approve"],
      })
    )
  )
  await enqueue({
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    request: {
      conversationRef: input.conversationRef,
      ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
      segments: [buildA2UISegment(surfaceId, surface)],
      metadata: { idempotencyKey: newIdempotencyKey() },
    },
    source: "ai-run",
  })
  await audit({
    adapterId: input.adapterId,
    kind: "media_grant.requested",
    at: now,
    conversationKey: input.conversationKey,
    fields: { provider: input.provider },
  })
}

export interface ApplyMediaGrantInput {
  adapterId: string
  conversationKey: string
  decision: MediaGrantDecision
  provider: string
  sessionId?: string
  now?: number
  // Injectable for tests.
  persist?: typeof updateConversationConfigSection
}

/**
 * Apply a button press: write (or clear) the conversation's grant.
 *
 * A refusal clears any existing grant rather than doing nothing — the person
 * pressing "not now" on a chat that was already granted means to withdraw it,
 * and leaving a stale grant in place would make the button a lie.
 */
export async function applyMediaGrantCallback(
  input: ApplyMediaGrantInput
): Promise<{ granted: boolean }> {
  const now = input.now ?? Date.now()
  const persist = input.persist ?? updateConversationConfigSection
  const grant = mediaGrantFor(input.decision, input.provider, now)
  await persist({
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    sessionId: input.sessionId,
    section: "permissions",
    patch: { mediaModelGrant: grant ?? undefined },
    source: "command.media_grant",
  })
  return { granted: grant !== null }
}
