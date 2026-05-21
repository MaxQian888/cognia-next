/**
 * Slack Block Kit → InboundA2UIBlock projection.
 *
 * Slack messages carry interactive structure via the `blocks` array
 * (https://api.slack.com/reference/block-kit/blocks). We map the major
 * block + element types into the adapter-neutral InboundA2UIBlock so
 * the Inbox detail pane renders cards, buttons, lists, and forms with
 * the same widget vocabulary the assistant uses on the outbound side.
 *
 * Unknown blocks/elements fall through into `raw` so operators can
 * always pop open the `<details>` and see the original JSON.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { flatten } from "../_shared/inbound-a2ui-types"

interface SlackTextObject {
  type?: "plain_text" | "mrkdwn"
  text?: string
  emoji?: boolean
}

interface SlackBlockElement {
  type?: string
  text?: SlackTextObject
  image_url?: string
  alt_text?: string
  url?: string
  action_id?: string
  value?: string
  style?: "primary" | "danger"
  options?: SlackBlockElement[]
}

interface SlackBlock {
  type?: string
  text?: SlackTextObject
  fields?: SlackTextObject[]
  elements?: SlackBlockElement[]
  accessory?: SlackBlockElement
  image_url?: string
  alt_text?: string
  block_id?: string
  title?: SlackTextObject
}

function textOf(obj: SlackTextObject | undefined | null): string {
  if (!obj) return ""
  if (typeof obj.text === "string") return obj.text
  return ""
}

function mapElement(el: SlackBlockElement): InboundA2UINode | null {
  switch (el.type) {
    case "button":
      return {
        kind: "button",
        label: textOf(el.text),
        url: el.url,
        actionId: el.action_id,
        style: el.style === "primary" ? "primary" : el.style === "danger" ? "danger" : "default",
      }
    case "image":
      if (!el.image_url) return null
      return { kind: "image", url: el.image_url, alt: el.alt_text }
    case "static_select":
    case "external_select":
    case "users_select":
    case "channels_select":
    case "conversations_select":
      // Slack selects render as a button + hint in the inbox — clicking
      // round-trips through the callback channel, which the assistant
      // then re-emits as the resolved option.
      return {
        kind: "button",
        label: textOf(el.text) || "Select…",
        actionId: el.action_id,
      }
    default:
      return null
  }
}

function mapBlock(block: SlackBlock): InboundA2UINode | null {
  switch (block.type) {
    case "header":
      return { kind: "heading", level: 2, text: textOf(block.text) }
    case "section": {
      const children: InboundA2UINode[] = []
      if (block.text) {
        children.push({
          kind: "text",
          text: textOf(block.text),
          emphasis: block.text.type === "mrkdwn" ? undefined : undefined,
        })
      }
      if (block.fields && block.fields.length > 0) {
        children.push({
          kind: "list",
          children: block.fields.map((f) => ({
            kind: "text" as const,
            text: textOf(f),
          })),
        })
      }
      if (block.accessory) {
        const accessory = mapElement(block.accessory)
        if (accessory) children.push(accessory)
      }
      if (children.length === 0) return null
      if (children.length === 1) return children[0]
      return { kind: "column", children }
    }
    case "image":
      if (!block.image_url) return null
      return { kind: "image", url: block.image_url, alt: block.alt_text }
    case "divider":
      return { kind: "divider" }
    case "actions": {
      const children = flatten((block.elements ?? []).map(mapElement))
      if (children.length === 0) return null
      return { kind: "row", children }
    }
    case "context": {
      const children: InboundA2UINode[] = []
      for (const el of block.elements ?? []) {
        if (el.type === "image" && el.image_url) {
          children.push({ kind: "image", url: el.image_url, alt: el.alt_text })
          continue
        }
        // Context elements with type mrkdwn / plain_text put the text
        // directly on `el.text` as a string rather than the nested
        // text-object Slack uses elsewhere — handle both shapes.
        let raw = ""
        if (typeof (el.text as unknown) === "string") {
          raw = el.text as unknown as string
        } else if (el.text) {
          raw = textOf(el.text)
        }
        if (raw) {
          children.push({ kind: "text", text: raw, emphasis: "muted" })
        }
      }
      if (children.length === 0) return null
      return { kind: "row", children }
    }
    default:
      return null
  }
}

/**
 * Convert a Slack message payload (the `blocks` array, optionally with a
 * fallback `text`) into an InboundA2UIBlock. Falls back to a single
 * `text` node when the message has no blocks.
 */
export function slackInboundToA2UI(payload: {
  blocks?: SlackBlock[]
  text?: string
}): InboundA2UIBlock | null {
  const blocks = payload.blocks ?? []
  const body = flatten(blocks.map(mapBlock))
  if (body.length === 0) {
    if (!payload.text) return null
    return { v: 1, source: "slack", body: [{ kind: "text", text: payload.text }] }
  }
  // Preserve original blocks under raw for the renderer's debug details.
  return {
    v: 1,
    source: "slack",
    body,
    raw: blocks.length > 0 ? blocks : undefined,
  }
}
