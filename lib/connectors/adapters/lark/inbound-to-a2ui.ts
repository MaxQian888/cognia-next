/**
 * Lark Interactive Card v2 → InboundA2UIBlock projection.
 *
 * Lark cards have a `header` (with `title.content`), an `elements`
 * array (or `i18n_elements`) plus optional `card_link`. Inside each
 * element the structure is recursive: `div`, `markdown`, `column_set`,
 * `image`, `button`, `select_static`, `form`, `action`, etc.
 *
 * We project the major shapes into InboundA2UIBlock. Unknown / form
 * elements fall through into `raw` so the operator can drop into the
 * `<details>` JSON view.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { flatten } from "../_shared/inbound-a2ui-types"

interface LarkCardElement {
  tag?: string
  content?: string
  text?: { tag?: string; content?: string }
  title?: { content?: string }
  alt?: { content?: string }
  img_key?: string
  url?: string
  multi_url?: { url?: string }
  value?: Record<string, unknown>
  type?: string
  options?: Array<{ text?: { content?: string }; value?: string }>
  columns?: Array<{ elements?: LarkCardElement[]; width?: number }>
  elements?: LarkCardElement[]
  actions?: LarkCardElement[]
  href?: string
}

interface LarkCardPayload {
  header?: {
    title?: { content?: string; tag?: string }
    subtitle?: { content?: string }
    template?: string
  }
  elements?: LarkCardElement[]
  i18n_elements?: { en_us?: LarkCardElement[]; zh_cn?: LarkCardElement[] }
  card_link?: { url?: string }
}

function textOf(el: LarkCardElement | undefined): string {
  if (!el) return ""
  if (el.content) return el.content
  if (el.text?.content) return el.text.content
  if (el.title?.content) return el.title.content
  return ""
}

function mapAction(action: LarkCardElement): InboundA2UINode | null {
  switch (action.tag) {
    case "button":
      return {
        kind: "button",
        label: textOf(action),
        url: action.url || action.multi_url?.url,
        actionId: (action.value?.action_id as string | undefined) ?? undefined,
        style:
          action.type === "primary" ? "primary" : action.type === "danger" ? "danger" : "default",
      }
    case "select_static":
      return {
        kind: "button",
        label: textOf(action) || "Select…",
        actionId: (action.value?.action_id as string | undefined) ?? undefined,
      }
    default:
      return null
  }
}

function mapElement(el: LarkCardElement): InboundA2UINode | null {
  switch (el.tag) {
    case "div":
    case "markdown":
      return { kind: "text", text: textOf(el) }
    case "hr":
      return { kind: "divider" }
    case "img":
      if (!el.img_key) return null
      // Lark hosts images behind img_key; the renderer falls back to
      // showing the key as a hyperlink while the operator clicks
      // through to the original message.
      return { kind: "image", url: `lark-img:${el.img_key}`, alt: textOf(el.alt) }
    case "action":
      if (el.actions && el.actions.length > 0) {
        return { kind: "row", children: flatten(el.actions.map(mapAction)) }
      }
      return null
    case "column_set":
      if (el.columns) {
        const cols: InboundA2UINode[] = []
        for (const col of el.columns) {
          if (col.elements && col.elements.length > 0) {
            cols.push({
              kind: "column",
              children: flatten(col.elements.map(mapElement)),
            })
          }
        }
        if (cols.length === 0) return null
        return { kind: "row", children: cols }
      }
      return null
    case "note":
      // Note elements are small italicised footers in Lark cards.
      return { kind: "text", text: textOf(el), emphasis: "muted" }
    default:
      return null
  }
}

/**
 * Minimal shape of the Lark event-subscription envelope this mapper is handed
 * in production. `projectInboundToA2UI` passes `event.raw` — the FULL envelope
 * (`{schema, header, event}`) — not a bare card. When the inbound message is an
 * interactive card, the card JSON lives *stringified* at `event.message.content`.
 */
interface LarkEnvelopeLike {
  header?: { event_type?: string }
  event?: {
    message?: { message_type?: string; content?: string }
  }
}

function isEnvelope(payload: unknown): payload is LarkEnvelopeLike {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "event" in payload &&
    typeof (payload as { event?: unknown }).event === "object" &&
    (payload as { event?: unknown }).event !== null
  )
}

/**
 * Resolve the actual interactive-card payload from whatever
 * `projectInboundToA2UI` handed us. Production passes the full event envelope,
 * whose interactive card is stringified at `event.message.content`; tests and
 * legacy callers pass a bare card payload directly. Returns null when there is
 * no interactive card to project (plain text / image / post messages, or a
 * malformed content string) so the bus falls through to plaintext rendering.
 */
function resolveCardPayload(payload: LarkCardPayload | LarkEnvelopeLike): LarkCardPayload | null {
  if (isEnvelope(payload)) {
    const message = payload.event?.message
    if (!message || message.message_type !== "interactive" || !message.content) return null
    try {
      return JSON.parse(message.content) as LarkCardPayload
    } catch {
      return null
    }
  }
  return payload as LarkCardPayload
}

/**
 * Convert a Lark interactive-card payload into an InboundA2UIBlock.
 * Accepts the full schema-2.0 event envelope (the production shape), the
 * new schema-2.0 card payload, and the older flat shape; mappers gracefully
 * skip elements they don't recognise.
 */
export function larkInboundToA2UI(
  payload: LarkCardPayload | LarkEnvelopeLike
): InboundA2UIBlock | null {
  const card = resolveCardPayload(payload)
  if (!card) return null
  const elements = card.elements ?? card.i18n_elements?.en_us ?? card.i18n_elements?.zh_cn ?? []
  if (elements.length === 0 && !card.header?.title?.content) return null
  const body: InboundA2UINode[] = []
  const headerTitle = card.header?.title?.content
  const headerSubtitle = card.header?.subtitle?.content
  if (headerTitle) {
    body.push({ kind: "heading", level: 2, text: headerTitle })
  }
  if (headerSubtitle) {
    body.push({ kind: "text", text: headerSubtitle, emphasis: "muted" })
  }
  body.push(...flatten(elements.map(mapElement)))
  if (card.card_link?.url) {
    body.push({ kind: "link", href: card.card_link.url, label: card.card_link.url })
  }
  if (body.length === 0) return null
  return {
    v: 1,
    source: "lark",
    title: headerTitle,
    body,
    raw: card,
  }
}
