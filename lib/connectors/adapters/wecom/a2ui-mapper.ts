/**
 * WeCom A2UI ⇄ template_card mapper.
 *
 * Outbound: project an interactive A2UI surface onto a WeCom
 * `template_card` (`button_interaction`). Only `Button` components map to
 * native card buttons — every button's `key` carries the deterministic
 * `a2ui:<surfaceId>:<componentId>:<action>` action id (recorded as a callback
 * binding) so the inbound `template_card_event` round-trips back to the right
 * surface. Surfaces with no buttons return `null` (the markdown body already
 * carries their `plainTextMirror`).
 *
 * Inbound: project a `template_card_event` into a `ConnectorCallbackEvent`
 * for `ConnectorBus.dispatchConnectorCallback`, mirroring the Slack pattern
 * (`triggerId = actionId`, surface recovered via the binding lookup).
 */

import type { A2UIMessageSegment } from "@/types/connectors/segment"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import { buildConversationKey } from "@/types/connectors/event"
import {
  walkA2UISurface,
  buildActionId,
  recordCallbackBinding,
  bindingHintFields,
} from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import type { WeComTemplateCard, WeComInboundEventBody } from "./protocol"

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}

/** WeCom button_interaction cards cap the button list; keep it conservative. */
const MAX_BUTTONS = 6

/**
 * Build a WeCom `template_card` (button_interaction) from an A2UI surface
 * segment, recording a callback binding for each button. Returns `null` when
 * the surface has no `Button` components — the caller then relies on the
 * markdown body + `plainTextMirror` instead.
 */
export async function buildWeComTemplateCard(
  adapterId: string,
  seg: A2UIMessageSegment,
  conversationKey?: string
): Promise<WeComTemplateCard | null> {
  const surface = seg.content
  let title = stringValue(surface.title)
  let desc = ""
  const buttons: Array<{ key: string; text: string; style?: number }> = []
  const bindingWrites: Promise<void>[] = []

  walkA2UISurface(surface, (node) => {
    switch (node.component) {
      case "Card":
        if (!title) title = stringValue(node.raw.title)
        break
      case "Text":
        if (!desc) desc = stringValue(node.raw.text)
        break
      case "Alert": {
        if (!desc) {
          const at = stringValue(node.raw.title)
          const ax = stringValue(node.raw.text)
          desc = at && ax ? `${at}: ${ax}` : at || ax
        }
        break
      }
      case "Button": {
        if (buttons.length >= MAX_BUTTONS) break
        const action = stringValue(node.raw.action) || node.id
        const text = stringValue(node.raw.text) || action
        const actionId = buildActionId(seg.surfaceId, node.id, action)
        buttons.push({ key: actionId, text, style: 1 })
        bindingWrites.push(
          recordCallbackBinding({
            adapterId,
            actionId,
            surfaceId: seg.surfaceId,
            componentId: node.id,
            conversationKey,
            ...bindingHintFields(node.raw),
          })
        )
        break
      }
      default:
        break
    }
  })

  if (buttons.length === 0) return null
  await Promise.all(bindingWrites)

  return {
    card_type: "button_interaction",
    main_title: { title: title || "Choose an action", desc: desc || undefined },
    sub_title_text: desc || undefined,
    button_list: buttons,
  }
}

/**
 * Minimal acknowledgement card sent via `aibot_respond_update_msg` within the
 * 5 s window after a `template_card_event`, so the user sees their click was
 * received while the assistant turn runs. Preserves the original `task_id`
 * when WeCom supplies one.
 */
export function buildAckUpdateCard(
  body: WeComInboundEventBody,
  ackText: string
): WeComTemplateCard {
  return {
    card_type: "button_interaction",
    main_title: { title: ackText },
    sub_title_text: ackText,
    task_id: body.event.template_card?.task_id,
    button_list: [],
  }
}

/** Parse `a2ui:<surfaceId>:<componentId>:<action>` back into its parts. */
export function parseActionId(
  actionId: string
): { surfaceId: string; componentId: string; action: string } | null {
  const parts = actionId.split(":")
  if (parts.length < 4 || parts[0] !== "a2ui") return null
  return { surfaceId: parts[1], componentId: parts[2], action: parts.slice(3).join(":") }
}

/**
 * Project a WeCom `template_card_event` into a `ConnectorCallbackEvent`.
 * `triggerId` is the button key (the baked action id) so the bus's binding
 * lookup recovers the surface; `surfaceId`/`componentId` are also parsed
 * inline as a fallback. Returns `null` for non-card events or missing keys.
 */
export function parseTemplateCardEvent(
  adapterId: string,
  selfId: string,
  body: WeComInboundEventBody,
  now: number = Date.now()
): ConnectorCallbackEvent | null {
  if (body.event.eventtype !== "template_card_event") return null
  const eventKey = body.event.template_card?.event_key
  if (!eventKey) return null

  const parsed = parseActionId(eventKey)
  const userId = body.from?.userid ?? "unknown"
  const conversationKey = body.chatid
    ? buildConversationKey("wecom", adapterId, body.chatid)
    : undefined

  return {
    platform: "wecom",
    adapterId,
    selfId,
    triggerId: eventKey,
    surfaceId: parsed?.surfaceId ?? "",
    componentId: parsed?.componentId,
    actionType: "button",
    value: parsed?.action ?? eventKey,
    conversationKey,
    user: {
      id: userId,
      platform: "wecom",
      adapterId,
      remoteUserId: userId,
      displayName: body.from?.name,
    },
    timestamp: now,
    raw: body,
  }
}
