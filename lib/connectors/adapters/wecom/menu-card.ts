/**
 * WeCom 智能机器人 quick-command "menu card".
 *
 * WeCom's bot protocol has no persistent menu surface (Feishu's
 * `application.bot.menu_v6` has no analogue). To approximate one we ride
 * the existing `template_card.button_interaction` payload: on
 * `enter_chat`, if the adapter has any configured quick commands, the
 * adapter pushes a card whose buttons are the menu. The button `key` is
 * `qc:<triggerKey>` — a namespace distinct from `a2ui:` (which the A2UI
 * mapper writes) and `wfapp:` / `wfcan:` (which the workflow approval
 * surface writes). The inbound template_card_event router checks each
 * namespace in order before falling through to the A2UI handler.
 *
 * Why a separate prefix rather than reusing `a2ui:` and routing on
 * binding kind: menu-card buttons do NOT need a Dexie callback binding
 * — the lookup happens purely against the in-memory quickCommands list
 * on the adapter. Adding a binding row per button on every enter_chat
 * would balloon the connectorCallbackBindings table without value.
 */

import type { IMQuickCommand } from "@/lib/connectors/quick-commands/types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { WeComInboundEventBody, WeComTemplateCard } from "./protocol"

const MAX_MENU_BUTTONS = 6
export const QC_KEY_PREFIX = "qc:"

/**
 * Build the menu template_card. Returns null when the list is empty so
 * the adapter can skip the push without emitting an empty card.
 *
 * Caller picks the optional `title` / `desc` text shown above the
 * buttons — defaults to a neutral "选择一个操作" label.
 */
export function buildWeComMenuCard(
  commands: IMQuickCommand[],
  opts: { title?: string; desc?: string } = {}
): WeComTemplateCard | null {
  if (!commands.length) return null
  const buttons = commands.slice(0, MAX_MENU_BUTTONS).map((c) => ({
    key: QC_KEY_PREFIX + c.triggerKey,
    text: c.label?.trim() || c.triggerKey,
    style: 1,
  }))
  const title = opts.title?.trim() || "选择一个操作"
  const desc = opts.desc?.trim() || undefined
  return {
    card_type: "button_interaction",
    main_title: { title, desc },
    sub_title_text: desc,
    button_list: buttons,
  }
}

/**
 * Inspect a template_card_event; if the click was on a menu button (the
 * key has the `qc:` prefix), return the underlying triggerKey so the
 * adapter can resolve the IMQuickCommand. Returns `null` for non-menu
 * events — the caller falls through to the A2UI handler.
 */
export function parseMenuButtonClick(body: WeComInboundEventBody): { triggerKey: string } | null {
  if (body.event.eventtype !== "template_card_event") return null
  const key = body.event.template_card?.event_key
  if (!key || !key.startsWith(QC_KEY_PREFIX)) return null
  return { triggerKey: key.slice(QC_KEY_PREFIX.length) }
}

/**
 * Synthesize a NormalizedInboundEvent so a menu-button click routes through
 * the same bus pipeline as a regular user message. Mirrors the Lark
 * `parseLarkBotMenuEvent` pattern. The resolved command's action value
 * (prompt text or slash line) becomes the synthetic message body so the
 * runtime ai-loop treats it identically to typed input.
 */
export function buildMenuClickInboundEvent(
  adapterId: string,
  selfId: string,
  body: WeComInboundEventBody,
  command: IMQuickCommand,
  now: number = Date.now()
): NormalizedInboundEvent | null {
  const chatId = body.chatid
  if (!chatId) return null
  const userId = body.from?.userid ?? "unknown"
  const conversationKey = buildConversationKey("wecom", adapterId, chatId)
  const text = command.action.value || command.label || command.triggerKey
  return {
    platform: "wecom",
    adapterId,
    selfId,
    messageId: `wecom.menu:${body.event.template_card?.task_id ?? command.triggerKey}:${now}`,
    conversationRef: { platform: "wecom", adapterId },
    conversationKey,
    sender: {
      id: userId,
      platform: "wecom",
      adapterId,
      remoteUserId: userId,
      displayName: body.from?.name,
    },
    channel: {
      id: chatId,
      kind: "private",
      platformChannelId: chatId,
    },
    segments: [{ type: "text", text }],
    plainText: text,
    mentions: { selfMentioned: false, users: [] },
    timestamp: now,
    raw: body,
    kind: "create",
  }
}
