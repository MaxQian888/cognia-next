/**
 * Telegram A2UI mapper — projects an `A2UISegmentContent` into one or
 * more Telegram Bot API calls.
 *
 * Native rendering coverage:
 *   - Text (heading variants → bold)         → sendMessage / inline text
 *   - Image                                  → sendPhoto (1) or sendMediaGroup (N)
 *   - Link                                   → sendMessage with [text](url) MD
 *   - Divider                                → sendMessage with `———`
 *   - Button (single)                        → InlineKeyboardMarkup row
 *   - ButtonGroup / Row of Buttons           → multi-row InlineKeyboardMarkup
 *   - Card (title + simple children)         → sendMessage with bold title
 *                                              + concatenated body + keyboard
 *
 * Everything else falls into the surface's `plainTextMirror`. Adapters
 * MUST also be tolerant of callers passing them an empty mapper output
 * (the surface had no native components) — the caller falls back to
 * `sendMessage(plainTextMirror)`.
 *
 * Telegram limits `callback_data` to 64 bytes; we use
 * `truncateActionId` + `recordCallbackBinding` so the long
 * `a2ui:<surfaceId>:<componentId>:<action>` id round-trips through
 * `connectorCallbackBindings` while only the short hash form goes on
 * the wire.
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"
import {
  buildActionId,
  recordCallbackBinding,
  truncateActionId,
  walkA2UISurface,
  type A2UIWalkNode,
  bindingHintFields,
} from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { escapeMdV2, escapeMdV2Code, escapeMdV2Url, TELEGRAM_CAPTION_LIMIT } from "./markdown-v2"
import type { SerializedTelegramCall } from "./serialize"

export interface TelegramMapperInput {
  adapterId: string
  chatId: string | number
  surfaceId: string
  surface: A2UISegmentContent
  /** Conversation key persisted on the binding row for callback routing. */
  conversationKey?: string
  /** Routing fields (reply_to, message_thread_id) common to all calls. */
  routing: Record<string, unknown>
}

interface InlineKeyboardButton {
  text: string
  /** Wire payload — 64-byte max. Long ids are stored in
   *  `connectorCallbackBindings` and a short hash form goes on the wire. */
  callback_data?: string
  url?: string
}

interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

/**
 * Build the Telegram API calls for an A2UI surface. Returns at least one
 * call (a sendMessage with the rendered body), plus optional sendPhoto /
 * sendMediaGroup calls for image components walked out of the tree.
 *
 * Awaited because `truncateActionId` and `recordCallbackBinding` are async
 * (the former hashes via Web Crypto, the latter persists to Dexie).
 */
export async function buildTelegramA2UICalls(
  input: TelegramMapperInput
): Promise<SerializedTelegramCall[]> {
  const calls: SerializedTelegramCall[] = []
  const lines: string[] = []
  const keyboard: InlineKeyboardButton[][] = []
  let currentRow: InlineKeyboardButton[] = []
  let lastEmittedWasButton = false

  const flushRow = () => {
    if (currentRow.length > 0) {
      keyboard.push(currentRow)
      currentRow = []
    }
  }

  // Per-node visitor — accumulates text lines + button rows; pushes
  // standalone sendPhoto calls as a side effect.
  const visit = async (node: A2UIWalkNode, depth: number): Promise<void> => {
    switch (node.component) {
      case "Text": {
        flushRow()
        lastEmittedWasButton = false
        const text = stringValue(node.raw.text)
        if (!text) return
        const variant = stringValue(node.raw.variant)
        if (variant === "heading1" || variant === "heading2" || variant === "heading3") {
          lines.push(`*${escapeMdV2(text)}*`)
        } else if (variant === "label") {
          lines.push(`_${escapeMdV2(text)}_`)
        } else if (variant === "code") {
          // Pre-entity context: only ` and \ are escaped (audited fix #4a).
          lines.push("```\n" + escapeMdV2Code(text) + "\n```")
        } else {
          lines.push(escapeMdV2(text))
        }
        break
      }
      case "Link": {
        flushRow()
        lastEmittedWasButton = false
        const text = stringValue(node.raw.text) || stringValue(node.raw.href)
        const href = stringValue(node.raw.href) || stringValue(node.raw.text)
        if (!href) return
        // Inside the (...) of an inline link only ) and \ must be escaped
        // (audited fix #4c) — a raw ")" in the href would end the link early.
        lines.push(`[${escapeMdV2(text || href)}](${escapeMdV2Url(href)})`)
        break
      }
      case "Divider": {
        flushRow()
        lastEmittedWasButton = false
        lines.push(escapeMdV2("———"))
        break
      }
      case "Image": {
        flushRow()
        lastEmittedWasButton = false
        const url = stringValue(node.raw.src) || stringValue(node.raw.url)
        if (!url) return
        const altRaw = stringValue(node.raw.alt)
        const payload: Record<string, unknown> = {
          chat_id: input.chatId,
          photo: url,
          ...input.routing,
        }
        const caption = altRaw ? escapeMdV2(altRaw) : ""
        if (caption && caption.length <= TELEGRAM_CAPTION_LIMIT) {
          payload.caption = caption
          payload.parse_mode = "MarkdownV2"
        }
        calls.push({ method: "sendPhoto", payload })
        if (caption.length > TELEGRAM_CAPTION_LIMIT) {
          // Telegram caps captions at 1024 chars (audited fix #7) — overflow
          // text rides in a follow-up sendMessage instead of a 400.
          calls.push({
            method: "sendMessage",
            payload: {
              chat_id: input.chatId,
              text: caption,
              parse_mode: "MarkdownV2",
              ...input.routing,
            },
          })
        }
        break
      }
      case "Button": {
        const text = stringValue(node.raw.text) || stringValue(node.raw.action) || "Button"
        const action = stringValue(node.raw.action) || node.id
        const href = stringValue(node.raw.href) || stringValue(node.raw.url)
        const fullActionId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullActionId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
          ...bindingHintFields(node.raw),
        })
        const { wireId } = await truncateActionId(fullActionId, 64)
        const button: InlineKeyboardButton = href
          ? { text, url: href }
          : { text, callback_data: wireId }
        // Consecutive sibling buttons share a row; any non-button node
        // between them resets `lastEmittedWasButton` and starts a fresh
        // row on the next button. Depth is currently informational only.
        void depth
        if (lastEmittedWasButton) {
          currentRow.push(button)
        } else {
          flushRow()
          currentRow.push(button)
        }
        lastEmittedWasButton = true
        break
      }
      case "Alert": {
        flushRow()
        lastEmittedWasButton = false
        const title = stringValue(node.raw.title)
        const text = stringValue(node.raw.text)
        if (title || text) {
          lines.push(
            `⚠️ *${escapeMdV2(title || "")}*${title && text ? ": " : ""}${escapeMdV2(text || "")}`
          )
        }
        break
      }
      case "Card": {
        flushRow()
        lastEmittedWasButton = false
        const title = stringValue(node.raw.title)
        if (title) lines.push(`*${escapeMdV2(title)}*`)
        break
      }
      case "Row":
      case "Column":
      case "List":
      case "ButtonGroup":
        // Layout-only — children carry the visible content; row break on entry.
        flushRow()
        lastEmittedWasButton = false
        break
      case "TextField":
      case "TextArea": {
        // B2 — ForceReply simulation (ADR-0009 v41). Telegram bots can't
        // surface a native text input, but `reply_markup.force_reply`
        // makes the client prefill a reply-to context that nudges the
        // user toward sending a free-text reply. The adapter's send loop
        // captures the returned platform message_id and records a
        // `kind: "force_reply"` binding so the parser can correlate the
        // next inbound `reply_to_message.message_id` back to this
        // component.
        flushRow()
        lastEmittedWasButton = false
        const label = stringValue(node.raw.label) || stringValue(node.raw.placeholder) || "Reply"
        const placeholder = stringValue(node.raw.placeholder) || label
        const promptText = escapeMdV2(label)
        const payload: Record<string, unknown> = {
          chat_id: input.chatId,
          text: promptText.length > 0 ? promptText : escapeMdV2("Reply"),
          parse_mode: "MarkdownV2",
          reply_markup: {
            force_reply: true,
            input_field_placeholder: placeholder.slice(0, 64),
            selective: true,
          },
          ...input.routing,
        }
        calls.push({
          method: "sendMessage",
          payload,
          forceReplyBinding: {
            surfaceId: input.surfaceId,
            componentId: node.id,
            conversationKey: input.conversationKey,
          },
        })
        break
      }
      default:
        // Unsupported component — caller's `plainTextMirror` fallback
        // covers it (the bus appends it as a sendMessage when our
        // returned calls are empty).
        break
    }
  }

  // Walk the surface in render order, awaiting each visit so async
  // binding records land in order.
  const nodes: Array<{ node: A2UIWalkNode; depth: number }> = []
  walkA2UISurface(input.surface, (node, depth) => {
    nodes.push({ node, depth })
  })
  for (const { node, depth } of nodes) {
    await visit(node, depth)
  }
  flushRow()

  // Compose the text body + keyboard into a single sendMessage. When the
  // surface produced no body text (image-only or button-only), skip the
  // sendMessage entirely.
  const body = lines.join("\n").trim()
  if (body.length > 0 || keyboard.length > 0) {
    const replyMarkup: InlineKeyboardMarkup | undefined =
      keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
    calls.push({
      method: "sendMessage",
      payload: {
        chat_id: input.chatId,
        text: body || "​", // zero-width space when keyboard exists but body is empty
        parse_mode: "MarkdownV2",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...input.routing,
      },
    })
  }

  return calls
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}
