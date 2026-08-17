/**
 * Slack Block Kit serialiser.
 *
 * Converts MessageSegments to a blocks[] array per
 * https://api.slack.com/block-kit
 *
 * Slack mrkdwn format notes:
 *  - *bold* and _italic_ work as-is (same as Slack mrkdwn)
 *  - Escape only <, >, & characters that would confuse Slack's own parser
 *  - <@userId> is the canonical mention format
 */

import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import {
  buildActionId,
  recordCallbackBinding,
  walkA2UISurface,
  type A2UIWalkNode,
  bindingHintFields,
} from "@/lib/connectors/adapters/_shared/a2ui-mapper"

// ---------------------------------------------------------------------------
// Block Kit types (minimal subset)
// ---------------------------------------------------------------------------

export interface MrkdwnTextObject {
  type: "mrkdwn"
  text: string
  verbatim?: boolean
}

export interface PlainTextObject {
  type: "plain_text"
  text: string
  emoji?: boolean
}

export interface SectionBlock {
  type: "section"
  text: MrkdwnTextObject | PlainTextObject
}

export interface ImageBlock {
  type: "image"
  image_url: string
  alt_text: string
}

export type SlackBlock = SectionBlock | ImageBlock

// ---------------------------------------------------------------------------
// Escape helper
// ---------------------------------------------------------------------------

/**
 * Escape characters that Slack's mrkdwn parser treats specially.
 * Only <, >, & need escaping — * _ ` ~ work as formatting and pass through.
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ---------------------------------------------------------------------------
// Block Kit hard limits (https://api.slack.com/reference/block-kit)
// Enforced by truncation, matching the defensive-trim precedent of
// `serializeAssistantSuggestedPrompts` (which slices to Slack's cap instead
// of letting the API 4xx).
// ---------------------------------------------------------------------------

/** Slack rejects messages with more than 50 blocks. */
export const MAX_BLOCKS_PER_MESSAGE = 50
/** `header` block plain_text is capped at 150 characters. */
export const HEADER_TEXT_MAX = 150
/** Button plain_text label is capped at 75 characters. */
export const BUTTON_TEXT_MAX = 75
/** static_select / radio_buttons accept at most 100 options. */
export const SELECT_OPTIONS_MAX = 100

/** Truncate to `max` characters, marking the cut with an ellipsis. */
function truncateWithEllipsis(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Clamp a blocks list to Slack's 50-blocks-per-message hard cap. */
export function clampBlocks<T>(blocks: T[]): T[] {
  return blocks.length > MAX_BLOCKS_PER_MESSAGE ? blocks.slice(0, MAX_BLOCKS_PER_MESSAGE) : blocks
}

// ---------------------------------------------------------------------------
// Segment → blocks
// ---------------------------------------------------------------------------

function sectionBlock(mrkdwn: string): SectionBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: mrkdwn },
  }
}

/**
 * Convert a single MessageSegment to one Slack Block Kit block.
 * Returns null for segment types that cannot be represented.
 */
export function segmentToBlock(seg: MessageSegment): SlackBlock | null {
  switch (seg.type) {
    case "text":
      return sectionBlock(escapeSlackMrkdwn(seg.text))

    case "markdown":
      // Slack mrkdwn is close to GitHub Markdown; pass through with < > & escaping
      return sectionBlock(escapeSlackMrkdwn(seg.md))

    case "image":
      return {
        type: "image",
        image_url: seg.url,
        alt_text: seg.alt ?? "image",
      }

    case "code": {
      const lang = seg.language ?? ""
      const block = lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
      return sectionBlock(block)
    }

    case "mention":
      return sectionBlock(`<@${seg.userId}>`)

    case "card":
      // Phase 1: opaque card → inline placeholder text
      return sectionBlock("[card]")

    case "file":
      // Phase 1: link in text
      return sectionBlock(`<${seg.url}|${escapeSlackMrkdwn(seg.name)}>`)

    case "reply":
    case "emoji":
    case "video":
    case "voice":
    case "location":
    case "poll":
      // Unsupported in Phase 1 — drop
      return null

    case "a2ui":
      // Sync path: fall back to the pre-baked text mirror. The async
      // serializer routes a2ui segments through `buildSlackA2UIBlocks`
      // which produces the full Block Kit projection (header / section /
      // actions / input blocks + callback bindings).
      return sectionBlock(escapeSlackMrkdwn(seg.plainTextMirror))

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Slack A2UI mapper (G3.3)
// ---------------------------------------------------------------------------

export interface SlackA2UIMapperInput {
  adapterId: string
  surfaceId: string
  surface: A2UISegmentContent
  conversationKey?: string
}

interface ActionsBlock {
  type: "actions"
  block_id?: string
  elements: Array<Record<string, unknown>>
}

interface InputBlock {
  type: "input"
  block_id?: string
  label: { type: "plain_text"; text: string }
  element: Record<string, unknown>
  optional?: boolean
}

interface HeaderBlock {
  type: "header"
  text: { type: "plain_text"; text: string }
}

interface DividerBlock {
  type: "divider"
}

interface ContextBlock {
  type: "context"
  elements: Array<{ type: "mrkdwn" | "plain_text" | "image"; [k: string]: unknown }>
}

export type SlackAnyBlock =
  SlackBlock | ActionsBlock | InputBlock | HeaderBlock | DividerBlock | ContextBlock

/**
 * Project an A2UI surface into Slack Block Kit blocks. Async because
 * each interactive component persists a `connectorCallbackBindings` row
 * so the inbound `block_actions` payload can route back to the right
 * surface/component.
 *
 * Covers Slack's richest native subset:
 *   - Card title → header block
 *   - Text / Link / Divider → section / divider
 *   - Image → image block (or section accessory when small)
 *   - Button / ButtonGroup → actions block with one element per Button
 *   - Select / RadioGroup / Checkbox / DatePicker / TimePicker /
 *     TextField / TextArea → input block (the inbound view_submission
 *     gathers their state on submit)
 *   - Alert → section with `:warning:` prefix
 */
export async function buildSlackA2UIBlocks(input: SlackA2UIMapperInput): Promise<SlackAnyBlock[]> {
  const out: SlackAnyBlock[] = []
  let pendingActions: ActionsBlock | null = null

  const flushActions = () => {
    if (pendingActions) {
      if (pendingActions.elements.length > 0) out.push(pendingActions)
      pendingActions = null
    }
  }

  const nodes: A2UIWalkNode[] = []
  walkA2UISurface(input.surface, (node) => {
    nodes.push(node)
  })

  for (const node of nodes) {
    switch (node.component) {
      case "Card": {
        flushActions()
        const title = stringValue(node.raw.title)
        if (title) {
          out.push({
            type: "header",
            text: { type: "plain_text", text: truncateWithEllipsis(title, HEADER_TEXT_MAX) },
          })
        }
        break
      }
      case "Alert": {
        flushActions()
        const title = stringValue(node.raw.title)
        const text = stringValue(node.raw.text)
        const body = [title ? `*${title}*` : "", text].filter(Boolean).join(" — ")
        out.push(sectionBlock(`:warning: ${escapeSlackMrkdwn(body)}`))
        break
      }
      case "Text": {
        flushActions()
        const text = stringValue(node.raw.text)
        if (!text) break
        const variant = stringValue(node.raw.variant)
        if (variant === "heading1" || variant === "heading2") {
          out.push({
            type: "header",
            text: { type: "plain_text", text: truncateWithEllipsis(text, HEADER_TEXT_MAX) },
          })
        } else if (variant === "heading3") {
          out.push(sectionBlock(`*${escapeSlackMrkdwn(text)}*`))
        } else {
          out.push(sectionBlock(escapeSlackMrkdwn(text)))
        }
        break
      }
      case "Link": {
        flushActions()
        const text = stringValue(node.raw.text) || stringValue(node.raw.href)
        const href = stringValue(node.raw.href)
        if (!href) break
        out.push(sectionBlock(`<${href}|${escapeSlackMrkdwn(text || href)}>`))
        break
      }
      case "Divider": {
        flushActions()
        out.push({ type: "divider" })
        break
      }
      case "Image": {
        flushActions()
        const url = stringValue(node.raw.src) || stringValue(node.raw.url)
        if (!url) break
        out.push({
          type: "image",
          image_url: url,
          alt_text: stringValue(node.raw.alt) || "image",
        })
        break
      }
      case "Button": {
        const label = stringValue(node.raw.text) || stringValue(node.raw.action) || "Button"
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
          ...bindingHintFields(node.raw),
        })
        const variant = stringValue(node.raw.variant)
        const style =
          variant === "primary" ? "primary" : variant === "destructive" ? "danger" : undefined
        const href = stringValue(node.raw.href) || stringValue(node.raw.url)
        if (!pendingActions) {
          pendingActions = { type: "actions", elements: [] }
        }
        const element: Record<string, unknown> = {
          type: "button",
          text: { type: "plain_text", text: truncateWithEllipsis(label, BUTTON_TEXT_MAX) },
          action_id: fullId,
          ...(style ? { style } : {}),
        }
        if (href) element.url = href
        else element.value = action
        pendingActions.elements.push(element)
        break
      }
      case "Select":
      case "RadioGroup": {
        flushActions()
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        const options = Array.isArray(node.raw.options)
          ? (node.raw.options as Array<Record<string, unknown>>)
              .filter((o) => o && (typeof o.value === "string" || typeof o.value === "number"))
              .slice(0, SELECT_OPTIONS_MAX)
              .map((o) => ({
                text: {
                  type: "plain_text" as const,
                  text: stringValue(o.label) || stringValue(o.value),
                },
                value: String(o.value),
              }))
          : []
        if (options.length === 0) break
        const label = stringValue(node.raw.label) || "Select"
        out.push({
          type: "input",
          block_id: `b_${node.id}`,
          label: { type: "plain_text", text: label },
          element: {
            type: node.component === "RadioGroup" ? "radio_buttons" : "static_select",
            action_id: fullId,
            options,
            ...(node.component === "Select" && stringValue(node.raw.placeholder)
              ? {
                  placeholder: {
                    type: "plain_text" as const,
                    text: stringValue(node.raw.placeholder),
                  },
                }
              : {}),
          },
        })
        break
      }
      case "Checkbox": {
        flushActions()
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        const label = stringValue(node.raw.label) || "Checkbox"
        out.push({
          type: "input",
          block_id: `b_${node.id}`,
          label: { type: "plain_text", text: label },
          element: {
            type: "checkboxes",
            action_id: fullId,
            options: [{ text: { type: "plain_text", text: label }, value: "true" }],
          },
          optional: true,
        })
        break
      }
      case "DatePicker": {
        flushActions()
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        const label = stringValue(node.raw.label) || "Date"
        out.push({
          type: "input",
          block_id: `b_${node.id}`,
          label: { type: "plain_text", text: label },
          element: { type: "datepicker", action_id: fullId },
          optional: !node.raw.required,
        })
        break
      }
      case "TimePicker": {
        flushActions()
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        const label = stringValue(node.raw.label) || "Time"
        out.push({
          type: "input",
          block_id: `b_${node.id}`,
          label: { type: "plain_text", text: label },
          element: { type: "timepicker", action_id: fullId },
          optional: !node.raw.required,
        })
        break
      }
      case "TextField":
      case "TextArea": {
        flushActions()
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        const label = stringValue(node.raw.label) || "Input"
        out.push({
          type: "input",
          block_id: `b_${node.id}`,
          label: { type: "plain_text", text: label },
          element: {
            type: "plain_text_input",
            action_id: fullId,
            multiline: node.component === "TextArea",
            ...(stringValue(node.raw.placeholder)
              ? {
                  placeholder: {
                    type: "plain_text" as const,
                    text: stringValue(node.raw.placeholder),
                  },
                }
              : {}),
          },
          optional: !node.raw.required,
        })
        break
      }
      // Layout-only — children traverse via the walker.
      case "Row":
      case "Column":
      case "List":
      case "ButtonGroup":
        flushActions()
        break
      default:
        break
    }
  }
  flushActions()

  return out
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}

/**
 * Convert a MessageSegment[] to a Slack blocks[] array.
 * Unsupported segment types are silently dropped.
 */
export function segmentsToBlocks(segments: MessageSegment[]): SlackBlock[] {
  const blocks: SlackBlock[] = []
  for (const seg of segments) {
    const block = segmentToBlock(seg)
    if (block !== null) {
      blocks.push(block)
    }
  }
  return blocks
}
