/**
 * Lark Interactive Card → InboundA2UIBlock projection.
 *
 * Two inputs reach this mapper. What Feishu actually delivers for an
 * `interactive` message — in `im.message.receive_v1` and in the message
 * history API — is NOT the card JSON that was sent but a converted form:
 * `{"title": "…", "elements": [[{tag:"text"|"a"|"at"|"img"|"button"|…}]]}`,
 * one inner array per line ("The received card structure is inconsistent
 * with the actual card JSON structure used when sending",
 * https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content).
 * `mapConvertedCard` projects that shape. The original card JSON (below) is
 * still accepted for callers that hold it, e.g. history fetched with
 * `card_msg_content_type=user_card_content`.
 *
 * Lark cards have an optional `header` (with `title.content`), a Card 2.0
 * `body.elements` array or legacy `elements` / `i18n_elements`, plus
 * optional `card_link`. Inside each
 * element the structure is recursive: `div`, `markdown`, `column_set`,
 * `image`, `button`, `select_static`, `form`, `action`, etc.
 *
 * We project the major shapes into InboundA2UIBlock. Unknown
 * elements fall through into `raw_json` so the operator can drop into the
 * `<details>` JSON view.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { flatten } from "../_shared/inbound-a2ui-types"
import { larkCardMarkdownToCommonMark } from "./card-markdown"
import { escapeMarkdown, markdownLinkDestination } from "../_shared/inbound-markdown"

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
  i18n_content?: Record<string, string>
  header?: { title?: { tag?: string; content?: string } }
  behaviors?: Array<{ type?: string; default_url?: string; value?: Record<string, unknown> }>
}

interface LarkCardPayload {
  schema?: string
  body?: { elements?: LarkCardElement[] }
  header?: {
    title?: { content?: string; tag?: string }
    subtitle?: { content?: string }
    template?: string
  }
  elements?: LarkCardElement[]
  i18n_elements?: { en_us?: LarkCardElement[]; zh_cn?: LarkCardElement[] }
  card_link?: { url?: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** First string among the candidates; card JSON is untrusted, so a truthy
 *  object in a text slot must never reach React as a child. */
function firstString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate
  }
  return ""
}

function textOf(el: LarkCardElement | undefined): string {
  if (!isRecord(el)) return ""
  const i18n = isRecord(el.i18n_content) ? el.i18n_content : undefined
  return firstString(
    i18n?.en_us,
    i18n?.zh_cn,
    el.content,
    isRecord(el.text) ? el.text.content : undefined,
    isRecord(el.title) ? el.title.content : undefined
  )
}

/** Card Markdown: the `markdown` component, or a `div` whose text is `lark_md`. */
function isMarkdownText(el: LarkCardElement): boolean {
  if (el.tag === "markdown" || el.tag === "lark_md") return true
  return isRecord(el.text) && el.text.tag === "lark_md"
}

function textNode(
  el: LarkCardElement,
  emphasis?: "muted"
): Extract<InboundA2UINode, { kind: "text" }> | null {
  const text = textOf(el)
  if (!text) return null
  const base = emphasis ? { kind: "text" as const, emphasis } : { kind: "text" as const }
  return isMarkdownText(el)
    ? { ...base, text: larkCardMarkdownToCommonMark(text), format: "markdown" }
    : { ...base, text }
}

function elementsOf(value: unknown): LarkCardElement[] {
  return Array.isArray(value) ? (value as LarkCardElement[]) : []
}

function mapAction(action: LarkCardElement): InboundA2UINode | null {
  switch (action.tag) {
    case "button":
      return {
        kind: "button",
        label: textOf(action),
        url:
          action.behaviors?.find((behavior) => behavior.type === "open_url")?.default_url ||
          action.url ||
          action.multi_url?.url,
        ...(actionIdOf(action) !== undefined ? { actionId: actionIdOf(action) } : {}),
        style: action.type?.startsWith("primary")
          ? "primary"
          : action.type?.startsWith("danger")
            ? "danger"
            : "default",
      }
    case "select_static":
      return {
        kind: "button",
        label: textOf(action) || "Select…",
        actionId: typeof action.value?.action_id === "string" ? action.value.action_id : "",
      }
    default:
      return null
  }
}

function actionIdOf(action: LarkCardElement): string | undefined {
  const callback = action.behaviors?.find((behavior) => behavior.type === "callback")
  if (!callback && !Object.hasOwn(action, "value")) return undefined
  const value = callback?.value ?? action.value
  const id = value?.actionId ?? value?.action_id
  // Empty IDs retain the callback marker; they must never become URL links.
  return typeof id === "string" ? id : ""
}

/** One node of the converted (received) card form. */
interface LarkConvertedNode {
  tag?: string
  text?: string
  href?: string
  user_id?: string
  user_name?: string
  image_key?: string
  type?: string
  placeholder?: string
  initial_date?: string
  elements?: unknown
}

/** Inline nodes of one converted line as Markdown; null for a control node. */
function convertedInline(node: LarkConvertedNode): string | null {
  switch (node.tag) {
    case "text":
      return escapeMarkdown(firstString(node.text))
    case "a": {
      const href = firstString(node.href)
      const label = escapeMarkdown(firstString(node.text) || href)
      return href ? `[${label}](${markdownLinkDestination(href)})` : label
    }
    case "at":
      return `@${escapeMarkdown(firstString(node.user_name, node.user_id) || "user")}`
    default:
      return null
  }
}

function convertedControl(node: LarkConvertedNode): InboundA2UINode[] {
  switch (node.tag) {
    case "img": {
      const key = firstString(node.image_key)
      return key ? [{ kind: "image", url: `lark-img:${key}` }] : []
    }
    case "button": {
      const type = firstString(node.type)
      return [
        {
          kind: "button",
          label: firstString(node.text),
          style: type.startsWith("primary")
            ? "primary"
            : type.startsWith("danger")
              ? "danger"
              : "default",
        },
      ]
    }
    case "select_static":
    case "overflow":
    case "date_picker":
      return [{ kind: "button", label: firstString(node.placeholder, node.initial_date) || "…" }]
    case "hr":
      return [{ kind: "divider" }]
    case "note":
      return convertedLine(elementsOf(node.elements) as LarkConvertedNode[], true)
    default:
      // Keep unknown content at its position rather than dropping it.
      return [{ kind: "raw_json", label: firstString(node.tag) || undefined, payload: node }]
  }
}

/** One converted line: runs of inline nodes become one Markdown text node. */
function convertedLine(nodes: unknown[], muted = false): InboundA2UINode[] {
  const out: InboundA2UINode[] = []
  let inline = ""
  const flush = () => {
    if (inline.trim()) {
      out.push({
        kind: "text",
        text: inline,
        format: "markdown",
        ...(muted ? { emphasis: "muted" as const } : {}),
      })
    }
    inline = ""
  }
  for (const raw of nodes) {
    if (!isRecord(raw)) continue
    const node = raw as LarkConvertedNode
    const text = convertedInline(node)
    if (text !== null) {
      inline += text
      continue
    }
    flush()
    out.push(...convertedControl(node))
  }
  flush()
  return out
}

interface LarkConvertedCard {
  title?: unknown
  elements: unknown[]
}

/** The received form: `elements` holds lines (arrays), not components. */
function isConvertedCard(card: unknown): card is LarkConvertedCard {
  return isRecord(card) && Array.isArray(card.elements) && card.elements.some(Array.isArray)
}

function mapConvertedCard(card: LarkConvertedCard): InboundA2UIBlock | null {
  const title = firstString(card.title) || undefined
  const body: InboundA2UINode[] = []
  if (title) body.push({ kind: "heading", level: 2, text: title })
  for (const line of card.elements) {
    if (!Array.isArray(line)) continue
    const nodes = convertedLine(line)
    if (nodes.length === 0) continue
    body.push(nodes.length === 1 ? nodes[0] : { kind: "row", children: nodes })
  }
  if (body.length === 0) return null
  return { v: 1, source: "lark", ...(title ? { title } : {}), body, raw: card }
}

function mapElement(el: LarkCardElement): InboundA2UINode | null {
  if (!el || typeof el !== "object") return null
  switch (el.tag) {
    case "button":
    case "select_static":
      return mapAction(el)
    case "form":
    case "interactive_container":
    case "column":
      return { kind: "column", children: flatten(elementsOf(el.elements).map(mapElement)) }
    case "collapsible_panel":
      return {
        kind: "card",
        title:
          isRecord(el.header) && isRecord(el.header.title)
            ? firstString(el.header.title.content) || undefined
            : undefined,
        children: flatten(elementsOf(el.elements).map(mapElement)),
      }
    case "div":
    case "markdown":
      return textNode(el)
    case "hr":
      return { kind: "divider" }
    case "img":
      if (typeof el.img_key !== "string" || !el.img_key) return null
      // Lark hosts images behind img_key, and the message-resource API
      // refuses card messages (error 234043), so no client can fetch it. The
      // renderer shows an "open in Lark" placeholder for this reference.
      return { kind: "image", url: `lark-img:${el.img_key}`, alt: textOf(el.alt) }
    case "action":
      if (Array.isArray(el.actions) && el.actions.length > 0) {
        return {
          kind: "row",
          children: flatten(
            el.actions.map((action) => (isRecord(action) ? mapAction(action) : null))
          ),
        }
      }
      return null
    case "column_set":
      if (Array.isArray(el.columns)) {
        const cols: InboundA2UINode[] = []
        for (const col of el.columns) {
          const colElements = isRecord(col) ? elementsOf(col.elements) : []
          if (colElements.length > 0) {
            cols.push({
              kind: "column",
              children: flatten(colElements.map(mapElement)),
            })
          }
        }
        if (cols.length === 0) return null
        return { kind: "row", children: cols }
      }
      return null
    case "note": {
      // Note elements are small footers in Lark cards; their text sits in
      // nested `elements` (plain_text / lark_md / img).
      const nested = flatten(elementsOf(el.elements).map((child) => textNode(child, "muted")))
      if (nested.length > 0)
        return nested.length === 1 ? nested[0] : { kind: "row", children: nested }
      return textNode(el, "muted")
    }
    default:
      // Retain unsupported content at its original position, including native
      // tables/charts/forms that the shared inbound vocabulary cannot express.
      return { kind: "raw_json", label: el.tag, payload: el }
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
      const parsed: unknown = JSON.parse(message.content)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as LarkCardPayload)
        : null
    } catch {
      return null
    }
  }
  return payload as LarkCardPayload
}

/**
 * Convert a Lark interactive-card payload into an InboundA2UIBlock.
 * Accepts the full schema-2.0 event envelope (the production shape), the
 * new schema-2.0 card payload, and the older flat shape; unknown components
 * retain their raw JSON at the original position.
 */
export function larkInboundToA2UI(
  payload: LarkCardPayload | LarkEnvelopeLike
): InboundA2UIBlock | null {
  const card = resolveCardPayload(payload)
  if (!card) return null
  if (isConvertedCard(card)) return mapConvertedCard(card)
  const i18nElements = isRecord(card.i18n_elements) ? card.i18n_elements : undefined
  const elements =
    ([
      isRecord(card.body) ? card.body.elements : undefined,
      card.elements,
      i18nElements?.en_us,
      i18nElements?.zh_cn,
    ].find(Array.isArray) as LarkCardElement[] | undefined) ?? []
  const header = isRecord(card.header) ? card.header : undefined
  const headerTitle =
    firstString(isRecord(header?.title) ? header.title.content : undefined) || undefined
  const headerSubtitle =
    firstString(isRecord(header?.subtitle) ? header.subtitle.content : undefined) || undefined
  if (elements.length === 0 && !headerTitle) return null
  const body: InboundA2UINode[] = []
  if (headerTitle) {
    body.push({ kind: "heading", level: 2, text: headerTitle })
  }
  if (headerSubtitle) {
    body.push({ kind: "text", text: headerSubtitle, emphasis: "muted" })
  }
  body.push(...flatten(elements.map(mapElement)))
  const cardLink = isRecord(card.card_link) ? firstString(card.card_link.url) : ""
  if (cardLink) {
    body.push({ kind: "link", href: cardLink, label: cardLink })
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
