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

function mapEmbed(embed: DiscordEmbed): InboundA2UINode | null {
  const children: InboundA2UINode[] = []
  if (embed.author?.name) {
    children.push({ kind: "text", text: embed.author.name, emphasis: "muted" })
  }
  if (embed.description) {
    children.push({ kind: "text", text: embed.description })
  }
  if (embed.fields && embed.fields.length > 0) {
    children.push({
      kind: "list",
      children: embed.fields.map((f) => ({
        kind: "text" as const,
        text: `${f.name ?? ""}${f.name && f.value ? ": " : ""}${f.value ?? ""}`,
      })),
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
    actionId: c.custom_id,
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
    actionId: c.custom_id,
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

export function discordInboundToA2UI(payload: {
  content?: string
  embeds?: DiscordEmbed[]
  components?: DiscordComponent[]
}): InboundA2UIBlock | null {
  const body: InboundA2UINode[] = []
  if (payload.content) {
    body.push({ kind: "text", text: payload.content })
  }
  for (const embed of payload.embeds ?? []) {
    const node = mapEmbed(embed)
    if (node) body.push(node)
  }
  for (const row of payload.components ?? []) {
    const node = mapActionRow(row)
    if (node) body.push(node)
  }
  if (body.length === 0) return null
  return { v: 1, source: "discord", body, raw: payload }
}
