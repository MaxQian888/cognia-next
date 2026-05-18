/**
 * Discord A2UI mapper — projects an `A2UISegmentContent` into a Discord
 * message payload (`embeds` + `components`).
 *
 * Native rendering coverage:
 *   - Text / Link / Divider                  → embed.description (markdown)
 *   - Card (title + body)                    → rich embed with title
 *   - Alert                                  → coloured embed (warning amber)
 *   - Image                                  → embed.image.url (1 per embed)
 *   - Button / ButtonGroup                   → ActionRow + Button (custom_id
 *                                              wires through callback bindings)
 *   - Select                                 → ActionRow + Select (one row)
 *   - Row / Column / List                    → layout-only, children traverse
 *
 * Discord limits:
 *   - Each message: max 10 embeds, max 5 ActionRows
 *   - Each ActionRow: max 5 Buttons OR 1 SelectMenu
 *   - Button.custom_id: max 100 chars (no truncation needed in practice)
 */

import type { A2UISegmentContent } from "@/types/connectors/segment"
import {
  buildActionId,
  recordCallbackBinding,
  walkA2UISurface,
  type A2UIWalkNode,
} from "@/lib/connectors/adapters/_shared/a2ui-mapper"

const MAX_BUTTONS_PER_ROW = 5
const MAX_ACTION_ROWS_PER_MESSAGE = 5
const CUSTOM_ID_MAX = 100
const ALERT_COLOUR = 0xfbbf24 // amber-400
const CARD_COLOUR = 0x6366f1 // indigo-500

export interface DiscordOutboundPayload {
  /** Body text — appended below the embeds. */
  content?: string
  embeds?: Record<string, unknown>[]
  components?: Record<string, unknown>[]
}

export interface DiscordMapperInput {
  adapterId: string
  surfaceId: string
  surface: A2UISegmentContent
  conversationKey?: string
}

interface ActionRow {
  type: 1
  components: Array<Record<string, unknown>>
}

/**
 * Build the Discord-payload form for an A2UI surface. Returns a single
 * payload that the adapter posts via `POST /channels/{channelId}/messages`.
 * Async because callback bindings persist to Dexie.
 */
export async function buildDiscordA2UIPayload(
  input: DiscordMapperInput
): Promise<DiscordOutboundPayload> {
  const nodes: Array<{ node: A2UIWalkNode; depth: number }> = []
  walkA2UISurface(input.surface, (node, depth) => {
    nodes.push({ node, depth })
  })

  const embeds: Record<string, unknown>[] = []
  const actionRows: ActionRow[] = []
  let currentRow: ActionRow | null = null
  const bodyLines: string[] = []
  let currentCardEmbed: Record<string, unknown> | null = null

  const ensureRow = (selectExclusive: boolean): ActionRow => {
    if (
      !currentRow ||
      currentRow.components.length >= MAX_BUTTONS_PER_ROW ||
      // Select menus must be alone in their row per Discord rules.
      selectExclusive ||
      (currentRow.components.length > 0 &&
        (currentRow.components[0] as { type: number }).type === 3)
    ) {
      if (actionRows.length >= MAX_ACTION_ROWS_PER_MESSAGE) {
        // Drop overflow silently — the assistant should have stayed within
        // Discord's row budget. Fallback text remains.
        return currentRow ?? { type: 1, components: [] }
      }
      currentRow = { type: 1, components: [] }
      actionRows.push(currentRow)
    }
    return currentRow
  }

  const flushCardEmbed = () => {
    if (currentCardEmbed) {
      embeds.push(currentCardEmbed)
      currentCardEmbed = null
    }
  }

  for (const { node } of nodes) {
    switch (node.component) {
      case "Card": {
        flushCardEmbed()
        currentCardEmbed = {
          color: CARD_COLOUR,
          title: stringValue(node.raw.title),
          description: "",
        }
        break
      }
      case "Alert": {
        flushCardEmbed()
        embeds.push({
          color: ALERT_COLOUR,
          title: `⚠️ ${stringValue(node.raw.title) || "Alert"}`,
          description: stringValue(node.raw.text),
        })
        break
      }
      case "Image": {
        const url = stringValue(node.raw.src) || stringValue(node.raw.url)
        if (!url) break
        if (currentCardEmbed && !currentCardEmbed.image) {
          currentCardEmbed.image = { url }
        } else {
          embeds.push({ image: { url } })
        }
        break
      }
      case "Text": {
        const text = stringValue(node.raw.text)
        if (!text) break
        if (currentCardEmbed) {
          const existing = stringValue(currentCardEmbed.description)
          currentCardEmbed.description = existing ? `${existing}\n${text}` : text
        } else {
          bodyLines.push(text)
        }
        break
      }
      case "Link": {
        const text = stringValue(node.raw.text) || stringValue(node.raw.href)
        const href = stringValue(node.raw.href)
        if (!href) break
        const line = `[${text || href}](${href})`
        if (currentCardEmbed) {
          const existing = stringValue(currentCardEmbed.description)
          currentCardEmbed.description = existing ? `${existing}\n${line}` : line
        } else {
          bodyLines.push(line)
        }
        break
      }
      case "Divider": {
        if (currentCardEmbed) {
          const existing = stringValue(currentCardEmbed.description)
          currentCardEmbed.description = existing ? `${existing}\n———` : "———"
        } else {
          bodyLines.push("———")
        }
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
        })
        const href = stringValue(node.raw.href) || stringValue(node.raw.url)
        const wireId = fullId.length > CUSTOM_ID_MAX ? `a2ui:${fullId.slice(-90)}` : fullId
        const row = ensureRow(false)
        if (row.components.length >= MAX_BUTTONS_PER_ROW) break
        if (href) {
          row.components.push({
            type: 2, // Button
            style: 5, // Link
            label,
            url: href,
          })
        } else {
          row.components.push({
            type: 2, // Button
            style: discordStyleForVariant(stringValue(node.raw.variant)),
            label,
            custom_id: wireId,
          })
        }
        break
      }
      case "Select":
      case "RadioGroup": {
        const action = stringValue(node.raw.action) || node.id
        const fullId = buildActionId(input.surfaceId, node.id, action)
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: fullId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
        const wireId = fullId.length > CUSTOM_ID_MAX ? `a2ui:${fullId.slice(-90)}` : fullId
        const options = Array.isArray(node.raw.options)
          ? (node.raw.options as Array<Record<string, unknown>>)
              .filter((o) => o && (typeof o.value === "string" || typeof o.value === "number"))
              .slice(0, 25) // Discord max
              .map((o) => ({
                label: stringValue(o.label) || stringValue(o.value) || "option",
                value: String(o.value),
                description: stringValue(o.description) || undefined,
              }))
          : []
        if (options.length === 0) break
        const row = ensureRow(true) // exclusive row
        row.components.push({
          type: 3, // SelectMenu
          custom_id: wireId,
          placeholder: stringValue(node.raw.placeholder) || stringValue(node.raw.label),
          options,
          min_values: node.component === "RadioGroup" ? 1 : 1,
          max_values: stringValue(node.raw.multiple) === "true" ? options.length : 1,
        })
        break
      }
      // Layout containers carry no visible content of their own.
      case "Row":
      case "Column":
      case "List":
      case "ButtonGroup":
        break
      default:
        // Unsupported components — caller's plainTextMirror covers it.
        break
    }
  }
  flushCardEmbed()

  return {
    content: bodyLines.join("\n").trim() || undefined,
    embeds: embeds.length > 0 ? embeds : undefined,
    components:
      actionRows.length > 0 ? (actionRows as unknown as Record<string, unknown>[]) : undefined,
  }
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}

/**
 * Map A2UI Button.variant to a Discord button style integer.
 *   1 = Primary (blue), 2 = Secondary (grey), 3 = Success (green),
 *   4 = Danger (red).
 */
function discordStyleForVariant(variant: string): number {
  switch (variant) {
    case "primary":
      return 1
    case "destructive":
      return 4
    case "secondary":
    case "outline":
    case "ghost":
      return 2
    default:
      return 1
  }
}
