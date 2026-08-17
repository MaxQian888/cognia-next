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
  bindingHintFields,
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

/** One TextInput inside a Discord modal (component type 4). */
export interface DiscordModalInput {
  customId: string
  label: string
  /** 1 = short (single-line), 2 = paragraph (multi-line). */
  style: 1 | 2
  required?: boolean
  placeholder?: string
  value?: string
  minLength?: number
  maxLength?: number
}

/**
 * The modal definition persisted in a `modal_open` callback binding's
 * `payload`. On click the adapter reconstitutes the InteractionResponse
 * (type 9) from it via {@link buildDiscordModalData}.
 */
export interface DiscordModalPayload {
  title: string
  inputs: DiscordModalInput[]
}

const MAX_MODAL_INPUTS = 5 // Discord modal cap
const DISCORD_LABEL_MAX = 45
const DISCORD_MODAL_TITLE_MAX = 45

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
        // The binding key MUST be the wire custom_id: the interaction echoes
        // the (possibly truncated) wire id back and `resolveCallbackBinding`
        // does an exact match — recording the untruncated fullId would break
        // every >100-char binding (mirrors the modal path below).
        const wireId = fullId.length > CUSTOM_ID_MAX ? `a2ui:${fullId.slice(-90)}` : fullId
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: wireId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
          ...bindingHintFields(node.raw),
        })
        const href = stringValue(node.raw.href) || stringValue(node.raw.url)
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
        // Same rule as Button: bind by the wire custom_id (exact-match lookup).
        const wireId = fullId.length > CUSTOM_ID_MAX ? `a2ui:${fullId.slice(-90)}` : fullId
        await recordCallbackBinding({
          adapterId: input.adapterId,
          actionId: wireId,
          surfaceId: input.surfaceId,
          componentId: node.id,
          conversationKey: input.conversationKey,
        })
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
      // TextField / TextArea / Dialog are consumed by the modal two-hop below.
      case "TextField":
      case "TextArea":
      case "Dialog":
        break
      default:
        // Unsupported components — caller's plainTextMirror covers it.
        break
    }
  }
  flushCardEmbed()

  // Modal two-hop (ADR-0026 Track B). Discord text inputs live ONLY inside
  // modals, never inline in a message. So a surface that carries text inputs
  // is projected as a single trigger Button bound (kind: "modal_open") to a
  // modal definition; on click the adapter answers InteractionResponse type 9
  // (see `buildDiscordModalData`). The modal submit then arrives as a
  // MODAL_SUBMIT interaction and round-trips through the normal binding lookup.
  const modalInputs = collectModalInputs(nodes)
  if (modalInputs.length > 0) {
    const dialogNode = nodes.find((n) => n.node.component === "Dialog")?.node
    const modalComponentId = dialogNode?.id ?? "modal"
    const title =
      stringValue(dialogNode?.raw.title) ||
      stringValue(dialogNode?.raw.text) ||
      modalInputs[0].label ||
      "Form"
    const fullId = buildActionId(input.surfaceId, modalComponentId, "submit")
    const wireId = fullId.length > CUSTOM_ID_MAX ? `a2ui:${fullId.slice(-90)}` : fullId
    // One binding serves both hops: the trigger click (kind → modal_open) and
    // the modal submit (same custom_id echoed back on MODAL_SUBMIT).
    await recordCallbackBinding({
      adapterId: input.adapterId,
      actionId: wireId,
      surfaceId: input.surfaceId,
      componentId: modalComponentId,
      conversationKey: input.conversationKey,
      kind: "modal_open",
      payload: { title, inputs: modalInputs } satisfies DiscordModalPayload,
    })
    const row = ensureRow(false)
    if (row.components.length < MAX_BUTTONS_PER_ROW) {
      row.components.push({
        type: 2, // Button
        style: 1, // Primary
        label:
          stringValue(dialogNode?.raw.trigger) || stringValue(dialogNode?.raw.title) || "Open form",
        custom_id: wireId,
      })
    }
  }

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
 * Collect the surface's text inputs (TextField / TextArea) into modal-input
 * descriptors, capped at Discord's 5-per-modal limit. Order follows the
 * render-order walk so the modal fields match the surface's layout.
 */
function collectModalInputs(
  nodes: Array<{ node: A2UIWalkNode; depth: number }>
): DiscordModalInput[] {
  const inputs: DiscordModalInput[] = []
  for (const { node } of nodes) {
    if (node.component !== "TextField" && node.component !== "TextArea") continue
    if (inputs.length >= MAX_MODAL_INPUTS) break
    const label = stringValue(node.raw.label) || stringValue(node.raw.placeholder) || node.id
    const required = node.raw.required === true || stringValue(node.raw.required) === "true"
    inputs.push({
      customId: node.id,
      label: label.slice(0, DISCORD_LABEL_MAX),
      style: node.component === "TextArea" ? 2 : 1,
      required,
      placeholder: stringValue(node.raw.placeholder) || undefined,
      value: stringValue(node.raw.value) || stringValue(node.raw.defaultValue) || undefined,
      minLength: typeof node.raw.minLength === "number" ? node.raw.minLength : undefined,
      maxLength: typeof node.raw.maxLength === "number" ? node.raw.maxLength : undefined,
    })
  }
  return inputs
}

/**
 * Build the `data` object for an InteractionResponse type 9 (MODAL) from a
 * persisted {@link DiscordModalPayload}. Each TextInput must sit alone in its
 * own ActionRow per Discord's modal rules.
 */
// GAP: modal Label (component type 18) migration — Discord is moving modal
// TextInputs from ActionRow wrappers to Label components; the ActionRow form
// still works and the migration is a separate follow-up.
export function buildDiscordModalData(
  customId: string,
  payload: DiscordModalPayload
): Record<string, unknown> {
  return {
    custom_id: customId,
    title: (payload.title || "Form").slice(0, DISCORD_MODAL_TITLE_MAX),
    components: payload.inputs.slice(0, MAX_MODAL_INPUTS).map((inp) => ({
      type: 1, // ActionRow
      components: [
        {
          type: 4, // TextInput
          custom_id: inp.customId,
          label: (inp.label || inp.customId).slice(0, DISCORD_LABEL_MAX),
          style: inp.style,
          required: inp.required ?? false,
          ...(inp.placeholder ? { placeholder: inp.placeholder.slice(0, 100) } : {}),
          ...(inp.value ? { value: inp.value } : {}),
          ...(inp.minLength !== undefined ? { min_length: inp.minLength } : {}),
          ...(inp.maxLength !== undefined ? { max_length: inp.maxLength } : {}),
        },
      ],
    })),
  }
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
