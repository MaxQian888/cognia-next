/**
 * Discord embeds + components → InboundA2UIBlock projection.
 *
 * Discord messages can carry:
 *   - embeds[] (title/description/fields/image/thumbnail/footer/url)
 *   - components[] (ActionRow → Button | Select)
 *
 * Each embed maps to a Card with its fields as a list; ActionRow maps
 * to a Row of buttons. Unknown component types and embed fields fall
 * through into `raw` for the renderer's debug view.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { flatten } from "../_shared/inbound-a2ui-types"
import { preserveLineBreaks } from "../_shared/inbound-markdown"

interface DiscordEmbedField {
  name?: string
  value?: string
  inline?: boolean
}

interface DiscordEmbed {
  title?: string
  description?: string
  url?: string
  color?: number
  fields?: DiscordEmbedField[]
  image?: { url?: string }
  thumbnail?: { url?: string }
  footer?: { text?: string; icon_url?: string }
  author?: { name?: string; url?: string; icon_url?: string }
}

interface DiscordComponent {
  type?: number
  components?: DiscordComponent[]
  label?: string
  url?: string
  custom_id?: string
  style?: number
  emoji?: { name?: string }
  placeholder?: string
}

/**
 * Discord's message Markdown is close enough to CommonMark to render as is;
 * only its single-newline line breaks need preserving. Mention tokens
 * (`<@id>`) are kept verbatim, exactly as the stored text parts hold them,
 * so a message whose only content is its text compares equal to its parts.
 */
function discordMarkdown(text: string): Extract<InboundA2UINode, { kind: "text" }> {
  return { kind: "text", text: preserveLineBreaks(text), format: "markdown" }
}

function mapEmbed(embed: DiscordEmbed): InboundA2UINode | null {
  const children: InboundA2UINode[] = []
  if (embed.author?.name) {
    children.push({ kind: "text", text: embed.author.name, emphasis: "muted" })
  }
  if (typeof embed.description === "string" && embed.description) {
    children.push(discordMarkdown(embed.description))
  }
  if (embed.fields && embed.fields.length > 0) {
    children.push({
      kind: "list",
      children: embed.fields.map((f) =>
        discordMarkdown(`${f.name ?? ""}${f.name && f.value ? ": " : ""}${f.value ?? ""}`)
      ),
    })
  }
  if (embed.image?.url) {
    children.push({ kind: "image", url: embed.image.url })
  }
  if (embed.thumbnail?.url && !embed.image?.url) {
    children.push({ kind: "image", url: embed.thumbnail.url, alt: "thumbnail" })
  }
  if (embed.url) {
    children.push({ kind: "link", href: embed.url, label: embed.url })
  }
  if (embed.footer?.text) {
    children.push({ kind: "text", text: embed.footer.text, emphasis: "muted" })
  }
  if (!embed.title && children.length === 0) return null
  return {
    kind: "card",
    title: embed.title,
    children,
  }
}

/**
 * Discord button styles:
 *   1 Primary (blue)  2 Secondary (grey)  3 Success (green)
 *   4 Danger (red)    5 Link (no callback)
 */
function styleOf(n: number | undefined): "primary" | "danger" | "default" {
  if (n === 4) return "danger"
  if (n === 1 || n === 3) return "primary"
  return "default"
}

function mapButtonComponent(c: DiscordComponent): InboundA2UINode | null {
  if (c.type !== 2) return null // Button
  const label = c.label ?? c.emoji?.name ?? ""
  if (!label && !c.custom_id && !c.url) return null
  return {
    kind: "button",
    label: label || "Action",
    url: c.url,
    ...(c.style !== 5 || Object.hasOwn(c, "custom_id")
      ? { actionId: typeof c.custom_id === "string" ? c.custom_id : "" }
      : {}),
    style: styleOf(c.style),
  }
}

function mapSelectComponent(c: DiscordComponent): InboundA2UINode | null {
  // Discord select menus surface as buttons in the inbox; the callback
  // round-trips to drive the assistant. Types 3/5/6/7/8 are select.
  if (![3, 5, 6, 7, 8].includes(c.type ?? -1)) return null
  return {
    kind: "button",
    label: c.placeholder ?? "Select…",
    actionId: typeof c.custom_id === "string" ? c.custom_id : "",
  }
}

function mapActionRow(row: DiscordComponent): InboundA2UINode | null {
  if (row.type !== 1) return null
  const children = flatten(
    (row.components ?? []).map((c) => mapButtonComponent(c) ?? mapSelectComponent(c))
  )
  if (children.length === 0) return null
  return { kind: "row", children }
}

interface DiscordMessageLike {
  content?: string
  embeds?: DiscordEmbed[]
  components?: DiscordComponent[]
}

/** Gateway dispatch the parser stores as `event.raw` (`discord/parse.ts`). */
interface DiscordDispatchLike {
  t?: string
  d?: DiscordMessageLike
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Resolve the message from whatever `projectInboundToA2UI` handed us.
 * Production passes the gateway dispatch (`{op, t, s, d}`, message under
 * `d`); tests and legacy callers pass a bare message.
 */
function resolveDiscordMessage(payload: unknown): DiscordMessageLike | null {
  if (!isRecord(payload)) return null
  if (typeof payload.t === "string" || "op" in payload) {
    return isRecord(payload.d) ? (payload.d as DiscordMessageLike) : null
  }
  return payload as DiscordMessageLike
}

export function discordInboundToA2UI(
  payload: DiscordMessageLike | DiscordDispatchLike
): InboundA2UIBlock | null {
  const message = resolveDiscordMessage(payload)
  if (!message) return null
  const body: InboundA2UINode[] = []
  if (typeof message.content === "string" && message.content) {
    body.push(discordMarkdown(message.content))
  }
  for (const embed of Array.isArray(message.embeds) ? message.embeds : []) {
    const node = isRecord(embed) ? mapEmbed(embed) : null
    if (node) body.push(node)
  }
  for (const row of Array.isArray(message.components) ? message.components : []) {
    const node = isRecord(row) ? mapActionRow(row) : null
    if (node) body.push(node)
  }
  if (body.length === 0) return null
  return { v: 1, source: "discord", body, raw: message }
}
