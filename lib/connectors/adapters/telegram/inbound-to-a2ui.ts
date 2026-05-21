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

export function telegramInboundToA2UI(payload: TelegramMessagePayload): InboundA2UIBlock | null {
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
  for (const row of payload.reply_markup?.inline_keyboard ?? []) {
    const children = flatten(row.map(mapButton))
    if (children.length > 0) body.push({ kind: "row", children })
  }
  if (body.length === 0) return null
  return { v: 1, source: "telegram", body, raw: payload }
}
