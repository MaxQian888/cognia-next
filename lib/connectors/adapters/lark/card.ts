/**
 * Lark card serialiser — Task 82.
 *
 * Converts MessageSegments to Lark API request body shapes
 * (im_v1 cards 2.0 / text / post / image).
 *
 * Lark markdown special chars that need escaping:
 *   \  →  \\
 *   @  →  \@  (would otherwise trigger a mention)
 *
 * Lark supports: **bold**, *italic*, [link](url), line breaks (\n).
 */

import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import type { ConnectorCallbackBindingKind } from "@/types/connectors/interaction"
import {
  buildActionId,
  recordCallbackBinding,
  walkA2UISurface,
  type A2UIWalkNode,
} from "@/lib/connectors/adapters/_shared/a2ui-mapper"

// ---------------------------------------------------------------------------
// Lark message body shape (im/v1/messages)
// ---------------------------------------------------------------------------

export type LarkMsgType = "text" | "interactive" | "image" | "post" | "audio" | "media" | "file"

export interface LarkMessageBody {
  msg_type: LarkMsgType
  /** JSON-stringified content per msg_type. */
  content: string
}

// ---------------------------------------------------------------------------
// Markdown escape
// ---------------------------------------------------------------------------

/**
 * Escape characters that Lark markdown treats specially.
 *
 * Lark uses @ for mentions and \ as an escape character.
 * We escape both so that user text containing these is rendered literally.
 */
export function escapeLarkMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/@/g, "\\@")
}

// ---------------------------------------------------------------------------
// Segment → Lark body
// ---------------------------------------------------------------------------

/**
 * Render a single MessageSegment as a LarkMessageBody.
 *
 * Voice/video/file/image segments must already carry a Lark-resolved key
 * (no `://` in the URL) — `resolveLarkMediaKeys` in `upload.ts` performs
 * the upload pre-pass. Segments whose URL is still a remote URL fall back
 * to a text-link rendering so the message is never silently dropped.
 *
 * `reply`, `emoji`, `location`, `poll` have no native Lark representation
 * and return null (the multi-segment combiner emits a `[type]` placeholder).
 */
export function segmentToLarkBody(seg: MessageSegment): LarkMessageBody | null {
  switch (seg.type) {
    case "text":
      return {
        msg_type: "text",
        content: JSON.stringify({ text: seg.text }),
      }

    case "markdown": {
      const escaped = escapeLarkMarkdown(seg.md)
      return {
        msg_type: "interactive",
        content: JSON.stringify({
          elements: [
            {
              tag: "div",
              text: { content: escaped, tag: "lark_md" },
            },
          ],
        }),
      }
    }

    case "image":
      // image_key body when the upload pre-pass has resolved the key;
      // otherwise fall back to a text-link rendering.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "image",
          content: JSON.stringify({ image_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[image](${seg.url})` }),
      }

    case "voice":
      // Lark requires opus voice via msg_type=audio + file_key. The upload
      // pre-pass resolves the key; bare URLs degrade to a text-link.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "audio",
          content: JSON.stringify({ file_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[voice](${seg.url})` }),
      }

    case "video":
      // msg_type=media for short-video file_keys. Bare URLs degrade to text.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "media",
          content: JSON.stringify({ file_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[video](${seg.url})` }),
      }

    case "file":
      // msg_type=file requires the uploaded file_key + file_name; URLs
      // degrade to a markdown-style link in text.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "file",
          content: JSON.stringify({ file_key: seg.url, file_name: seg.name }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[${seg.name}](${seg.url})` }),
      }

    case "code": {
      const lang = seg.language ?? ""
      const block = lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
      return {
        msg_type: "text",
        content: JSON.stringify({ text: block }),
      }
    }

    case "mention":
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `<at open_id="${seg.userId}"></at>` }),
      }

    case "card":
      // Phase 1: opaque card → plain text placeholder
      return {
        msg_type: "text",
        content: JSON.stringify({ text: "[card]" }),
      }

    case "a2ui":
      // Sync fallback: plain text mirror. `serializeOutboundAsync`
      // routes a2ui segments through `buildLarkA2UICard` for the full
      // Lark Interactive Card projection.
      return {
        msg_type: "text",
        content: JSON.stringify({ text: seg.plainTextMirror }),
      }

    case "reply":
    case "emoji":
    case "location":
    case "poll":
      return null

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Lark A2UI mapper — Interactive Card projection (G3.4)
// ---------------------------------------------------------------------------

export interface LarkA2UIMapperInput {
  adapterId: string
  surfaceId: string
  surface: A2UISegmentContent
  conversationKey?: string
}

interface LarkCardElement {
  tag: string
  [k: string]: unknown
}

/**
 * Project an A2UI surface into a Lark Interactive Card body.
 *
 * Native rendering:
 *   - Card title → `header.title.content`
 *   - Text / Link → `div` + `lark_md`
 *   - Divider → `hr`
 *   - Image → `img`
 *   - Button / ButtonGroup → `action` with `button` actions
 *   - Select → `select_static` inside `action`
 *   - DatePicker / TimePicker → `picker_date` / `picker_time` inside `action`
 *   - TextField / TextArea → `input` element
 *   - Alert → coloured `div` with prefix
 *
 * Returns a single `LarkMessageBody` with `msg_type=interactive`. When
 * the surface has no native components the body is a plain text mirror.
 */
export async function buildLarkA2UICard(input: LarkA2UIMapperInput): Promise<LarkMessageBody> {
  const elements: LarkCardElement[] = []
  let header: { title: { content: string; tag: string } } | undefined
  let currentAction: { tag: string; actions: LarkCardElement[] } | null = null

  const flushAction = () => {
    if (currentAction && currentAction.actions.length > 0) {
      elements.push(currentAction as unknown as LarkCardElement)
      currentAction = null
    } else if (currentAction) {
      currentAction = null
    }
  }
  const ensureAction = () => {
    if (!currentAction) currentAction = { tag: "action", actions: [] }
    return currentAction
  }

  const nodes: A2UIWalkNode[] = []
  walkA2UISurface(input.surface, (node) => {
    nodes.push(node)
  })

  for (const node of nodes) {
    switch (node.component) {
      case "Card": {
        flushAction()
        const title = stringValue(node.raw.title)
        if (title) {
          header = { title: { content: title, tag: "plain_text" } }
        }
        break
      }
      case "Alert": {
        flushAction()
        const title = stringValue(node.raw.title)
        const text = stringValue(node.raw.text)
        elements.push({
          tag: "div",
          text: {
            tag: "lark_md",
            content: `⚠️ **${escapeLarkMarkdown(title || "Alert")}**${title && text ? " — " : ""}${escapeLarkMarkdown(text)}`,
          },
        })
        break
      }
      case "Text": {
        flushAction()
        const text = stringValue(node.raw.text)
        if (!text) break
        const variant = stringValue(node.raw.variant)
        const md =
          variant === "heading1" || variant === "heading2" || variant === "heading3"
            ? `**${escapeLarkMarkdown(text)}**`
            : escapeLarkMarkdown(text)
        elements.push({ tag: "div", text: { tag: "lark_md", content: md } })
        break
      }
      case "Link": {
        flushAction()
        const text = stringValue(node.raw.text) || stringValue(node.raw.href)
        const href = stringValue(node.raw.href)
        if (!href) break
        elements.push({
          tag: "div",
          text: { tag: "lark_md", content: `[${escapeLarkMarkdown(text || href)}](${href})` },
        })
        break
      }
      case "Divider": {
        flushAction()
        elements.push({ tag: "hr" })
        break
      }
      case "Image": {
        flushAction()
        const url = stringValue(node.raw.src) || stringValue(node.raw.url)
        if (!url) break
        // Lark `img` requires an `img_key` (file_key) — bare URLs aren't
        // accepted by the card runtime. Until upload pre-pass is wired
        // for cards we fall back to a markdown link.
        if (!url.includes("://")) {
          elements.push({
            tag: "img",
            img_key: url,
            alt: { tag: "plain_text", content: stringValue(node.raw.alt) || "image" },
          })
        } else {
          elements.push({
            tag: "div",
            text: {
              tag: "lark_md",
              content: `[${escapeLarkMarkdown(stringValue(node.raw.alt) || "image")}](${url})`,
            },
          })
        }
        break
      }
      case "Button": {
        const label = stringValue(node.raw.text) || stringValue(node.raw.action) || "Button"
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        // A button may carry an explicit binding-kind hint (e.g. a
        // help/welcome card's quick-command button sets
        // `bindingKind: "help_quick_command"` + `bindingPayload`). When
        // present we record under that kind so the bus routes the click
        // to the matching short-circuit; absent, the default
        // `callback_query` kind keeps every existing button working.
        const bindingKind =
          typeof node.raw.bindingKind === "string"
            ? (node.raw.bindingKind as ConnectorCallbackBindingKind)
            : undefined
        const bindingPayload =
          node.raw.bindingPayload && typeof node.raw.bindingPayload === "object"
            ? (node.raw.bindingPayload as Record<string, unknown>)
            : undefined
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
          ...(bindingKind ? { kind: bindingKind } : {}),
          ...(bindingPayload ? { payload: bindingPayload } : {}),
        })
        const variant = stringValue(node.raw.variant)
        const type =
          variant === "primary" ? "primary" : variant === "destructive" ? "danger" : "default"
        const href = stringValue(node.raw.href) || stringValue(node.raw.url)
        const row = ensureAction()
        row.actions.push({
          tag: "button",
          text: { tag: "plain_text", content: label },
          type,
          ...(href
            ? { url: href }
            : { value: { actionId: fullId, surfaceId: input.surfaceId, componentId: node.id } }),
        })
        break
      }
      case "Select":
      case "RadioGroup": {
        flushAction()
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
              .map((o) => ({
                text: { tag: "plain_text", content: stringValue(o.label) || stringValue(o.value) },
                value: String(o.value),
              }))
          : []
        if (options.length === 0) break
        const row = ensureAction()
        row.actions.push({
          tag: "select_static",
          placeholder: {
            tag: "plain_text",
            content: stringValue(node.raw.placeholder) || stringValue(node.raw.label) || "Select",
          },
          options,
          value: { actionId: fullId, surfaceId: input.surfaceId, componentId: node.id },
        })
        flushAction()
        break
      }
      case "Checkbox": {
        // B4 — simulated stand-in (ADR-0009 v41). Lark interactive cards
        // 2.0 have no native single-checkbox element, so we render the
        // component as a two-option `select_static` ("✓" / "✗"). The
        // assistant treats the inbound value as a boolean.
        flushAction()
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        const label = stringValue(node.raw.label) || stringValue(node.raw.text) || "Checkbox"
        const initial =
          node.raw.value === true || stringValue(node.raw.value) === "true" ? "true" : "false"
        const row = ensureAction()
        row.actions.push({
          tag: "select_static",
          placeholder: { tag: "plain_text", content: label },
          // Lark renders the selected option's text in the trigger so
          // labelling each option with its own glyph makes the toggle
          // legible even before the user opens the dropdown.
          options: [
            {
              text: { tag: "plain_text", content: `${label}: ✓` },
              value: "true",
            },
            {
              text: { tag: "plain_text", content: `${label}: ✗` },
              value: "false",
            },
          ],
          initial_option: initial,
          value: {
            actionId: fullId,
            surfaceId: input.surfaceId,
            componentId: node.id,
            // Mark the wire payload as a simulated checkbox so the parser
            // can coerce the returned "true"/"false" string back into a
            // boolean before handing the event to the A2UI bridge.
            simulatedCheckbox: true,
          },
        })
        flushAction()
        break
      }
      case "DatePicker":
      case "TimePicker": {
        flushAction()
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        const row = ensureAction()
        row.actions.push({
          tag: node.component === "DatePicker" ? "picker_date" : "picker_time",
          placeholder: {
            tag: "plain_text",
            content:
              stringValue(node.raw.label) || (node.component === "DatePicker" ? "Date" : "Time"),
          },
          value: { actionId: fullId, surfaceId: input.surfaceId, componentId: node.id },
        })
        flushAction()
        break
      }
      case "TextField":
      case "TextArea": {
        flushAction()
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        elements.push({
          tag: "input",
          placeholder: {
            tag: "plain_text",
            content: stringValue(node.raw.placeholder) || stringValue(node.raw.label) || "Input",
          },
          rows: node.component === "TextArea" ? 4 : 1,
          value: { actionId: fullId, surfaceId: input.surfaceId, componentId: node.id },
        })
        break
      }
      case "Dialog":
      case "Drawer":
      case "Sheet": {
        // Simulated overlay projection — Lark v1 interactive cards have
        // no modal/drawer runtime, so the overlay's children (already
        // visited by `walkA2UISurface` via `body` / `children`) render
        // inline. Emit a divider + bold title so the section reads as a
        // distinct form block instead of blending into the card body.
        flushAction()
        elements.push({ tag: "hr" })
        const title = stringValue(node.raw.title)
        if (title) {
          elements.push({
            tag: "div",
            text: { tag: "lark_md", content: `**${escapeLarkMarkdown(title)}**` },
          })
        }
        break
      }
      case "Row":
      case "Column":
      case "List":
      case "ButtonGroup":
        flushAction()
        break
      default:
        break
    }
  }
  flushAction()

  if (elements.length === 0 && !header) {
    return {
      msg_type: "text",
      content: JSON.stringify({ text: "[empty]" }),
    }
  }

  const card: Record<string, unknown> = { elements }
  if (header) card.header = header
  return {
    msg_type: "interactive",
    content: JSON.stringify(card),
  }
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}

/**
 * Async serializer used by the production adapter `send()`. When a
 * segment list contains any `a2ui` segment, the whole message collapses
 * into a single Lark Interactive Card (composed from each a2ui surface
 * + the text/markdown tail). Otherwise delegates to the sync
 * `segmentsToLarkBody`.
 *
 * Lark's `/im/v1/messages` accepts one body per call, so combining
 * everything into a single interactive card preserves the assistant's
 * intended layout without an extra round-trip.
 */
export async function segmentsToLarkBodyAsync(
  segments: MessageSegment[],
  ctx: {
    adapterId: string
    /** Conversation key persisted on each callback binding row. */
    conversationKey?: string
  }
): Promise<LarkMessageBody> {
  const hasA2UI = segments.some((s) => s.type === "a2ui")
  if (!hasA2UI) return segmentsToLarkBody(segments)

  // Compose a single interactive card that interleaves text/markdown
  // segments as `div` elements with each a2ui surface's projected
  // elements. Header taken from the first a2ui surface's `title`.
  const combinedElements: Record<string, unknown>[] = []
  let header: Record<string, unknown> | undefined

  for (const seg of segments) {
    if (seg.type === "a2ui") {
      const body = await buildLarkA2UICard({
        adapterId: ctx.adapterId,
        surfaceId: seg.surfaceId,
        surface: seg.content,
        conversationKey: ctx.conversationKey,
      })
      if (body.msg_type === "interactive") {
        const parsed = JSON.parse(body.content) as {
          header?: Record<string, unknown>
          elements?: Record<string, unknown>[]
        }
        if (!header && parsed.header) header = parsed.header
        if (parsed.elements) combinedElements.push(...parsed.elements)
      }
      continue
    }
    if (seg.type === "text" || seg.type === "markdown") {
      const text = seg.type === "text" ? seg.text : seg.md
      if (!text) continue
      combinedElements.push({
        tag: "div",
        text: { tag: "lark_md", content: escapeLarkMarkdown(text) },
      })
      continue
    }
    // Image segments whose upload pre-pass already resolved a Lark
    // image_key render as a real `img` element inside the combined card
    // instead of degrading to a `[image]` placeholder.
    if (seg.type === "image" && !seg.url.includes("://")) {
      combinedElements.push({
        tag: "img",
        img_key: seg.url,
        alt: { tag: "plain_text", content: seg.alt || "image" },
      })
      continue
    }
    // Other segments (file / voice / etc.): fall through to a textual
    // placeholder element — Lark cards can't host those media kinds
    // mid-card.
    combinedElements.push({
      tag: "div",
      text: { tag: "lark_md", content: `[${seg.type}]` },
    })
  }

  const card: Record<string, unknown> = { elements: combinedElements }
  if (header) card.header = header
  return {
    msg_type: "interactive",
    content: JSON.stringify(card),
  }
}

/**
 * Convert a MessageSegment[] to a single LarkMessageBody.
 *
 * For multi-segment payloads we combine them into a single text/post body.
 * Segments that have no Lark representation are silently dropped.
 */
export function segmentsToLarkBody(segments: MessageSegment[]): LarkMessageBody {
  if (segments.length === 1) {
    const body = segmentToLarkBody(segments[0])
    if (body) return body
  }

  // Multi-segment or fallback: combine into a single text message where possible
  const textParts: string[] = []
  for (const seg of segments) {
    const body = segmentToLarkBody(seg)
    if (!body) continue

    if (body.msg_type === "text") {
      const parsed = JSON.parse(body.content) as { text?: string }
      if (parsed.text) textParts.push(parsed.text)
    } else {
      // For non-text types in a multi-segment, fall back to a plain label
      textParts.push(`[${seg.type}]`)
    }
  }

  const combined = textParts.join("\n")
  return {
    msg_type: "text",
    content: JSON.stringify({ text: combined || "[empty]" }),
  }
}
