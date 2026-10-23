/**
 * Telegram inline keyboard → InboundA2UIBlock projection.
 *
 * Telegram messages carry a `text` body + optional `reply_markup`:
 *   - inline_keyboard: 2-D array of buttons (url / callback_data / login_url / web_app)
 *   - one_time_keyboard: deprecated reply keyboards (not handled here)
 *
 * Each inline-keyboard row maps to an InboundA2UI row of buttons; the
 * outer text becomes a leading text node. Photo/document attachments
 * map to image / link nodes when present.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { flatten } from "../_shared/inbound-a2ui-types"

interface TelegramInlineButton {
  text?: string
  url?: string
  callback_data?: string
  login_url?: { url?: string }
  web_app?: { url?: string }
}

interface TelegramReplyMarkup {
  inline_keyboard?: TelegramInlineButton[][]
}

interface TelegramPhotoSize {
  file_id?: string
  width?: number
  height?: number
}

interface TelegramDocument {
  file_id?: string
  file_name?: string
  mime_type?: string
}

interface TelegramMessagePayload {
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  reply_markup?: TelegramReplyMarkup
}

function mapButton(button: TelegramInlineButton): InboundA2UINode | null {
  const label = button.text ?? ""
  if (!label && !button.url && !button.callback_data) return null
  const url = button.url ?? button.login_url?.url ?? button.web_app?.url
  return {
    kind: "button",
    label: label || "Action",
    url,
    actionId: button.callback_data,
  }
}

/** Update fields that carry a Message object (Bot API `Update`). */
const UPDATE_MESSAGE_FIELDS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
  "guest_message",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Resolve the message from whatever `projectInboundToA2UI` handed us.
 * Production passes the whole `Update` (`telegram/parse.ts` stores
 * `raw: rawUpdate`); tests and legacy callers pass a bare message. An update
 * that carries no message (callback query, reaction) has nothing to project.
 */
function resolveTelegramMessage(payload: unknown): TelegramMessagePayload | null {
  if (!isRecord(payload)) return null
  if ("update_id" in payload) {
    for (const field of UPDATE_MESSAGE_FIELDS) {
      const message = payload[field]
      if (isRecord(message)) return message as TelegramMessagePayload
    }
    return null
  }
  return payload as TelegramMessagePayload
}

export function telegramInboundToA2UI(
  input: TelegramMessagePayload | { update_id: number }
): InboundA2UIBlock | null {
  const payload = resolveTelegramMessage(input)
  if (!payload) return null
  const body: InboundA2UINode[] = []
  if (payload.text) {
    body.push({ kind: "text", text: payload.text })
  }
  // Telegram puts the largest size last; show the biggest photo.
  if (payload.photo && payload.photo.length > 0) {
    const biggest = payload.photo[payload.photo.length - 1]
    if (biggest.file_id) {
      body.push({
        kind: "image",
        url: `telegram-file:${biggest.file_id}`,
        alt: payload.caption,
        width: biggest.width,
        height: biggest.height,
      })
    }
  }
  if (payload.document?.file_id) {
    body.push({
      kind: "link",
      href: `telegram-file:${payload.document.file_id}`,
      label: payload.document.file_name ?? payload.document.mime_type ?? "Attachment",
    })
  }
  if (payload.caption && !payload.text) {
    body.push({ kind: "text", text: payload.caption, emphasis: "muted" })
  }
  const keyboard = payload.reply_markup?.inline_keyboard
  for (const row of Array.isArray(keyboard) ? keyboard : []) {
    if (!Array.isArray(row)) continue
    const children = flatten(row.map((button) => (isRecord(button) ? mapButton(button) : null)))
    if (children.length > 0) body.push({ kind: "row", children })
  }
  if (body.length === 0) return null
  return { v: 1, source: "telegram", body, raw: payload }
}
