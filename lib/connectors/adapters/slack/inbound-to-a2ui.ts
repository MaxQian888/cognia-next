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
import { slackMrkdwnToMarkdown } from "./mrkdwn-to-markdown"

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
  if (!isObject(obj)) return ""
  if (typeof obj.text === "string") return obj.text
  return ""
}

/** A text object as a text node: `mrkdwn` is converted and rendered formatted. */
function textNode(
  obj: SlackTextObject | undefined,
  emphasis?: "muted"
): Extract<InboundA2UINode, { kind: "text" }> | null {
  const text = textOf(obj)
  if (!text) return null
  const base = emphasis ? { kind: "text" as const, emphasis } : { kind: "text" as const }
  return obj?.type === "mrkdwn"
    ? { ...base, text: slackMrkdwnToMarkdown(text), format: "markdown" }
    : { ...base, text }
}

function mapElement(el: SlackBlockElement): InboundA2UINode | null {
  if (!isObject(el)) return null
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
  if (!isObject(block)) return null
  switch (block.type) {
    case "header":
      return { kind: "heading", level: 2, text: textOf(block.text) }
    case "section": {
      const children: InboundA2UINode[] = []
      const text = textNode(block.text)
      if (text) children.push(text)
      if (Array.isArray(block.fields) && block.fields.length > 0) {
        const fields = flatten(block.fields.map((f) => textNode(f)))
        if (fields.length > 0) children.push({ kind: "list", children: fields })
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
      const children = flatten(
        (Array.isArray(block.elements) ? block.elements : []).map(mapElement)
      )
      if (children.length === 0) return null
      return { kind: "row", children }
    }
    case "context": {
      const children: InboundA2UINode[] = []
      for (const el of Array.isArray(block.elements) ? block.elements : []) {
        if (!isObject(el)) continue
        if (el.type === "image" && el.image_url) {
          children.push({ kind: "image", url: el.image_url, alt: el.alt_text })
          continue
        }
        // Context elements with type mrkdwn / plain_text put the text
        // directly on `el.text` as a string rather than the nested
        // text-object Slack uses elsewhere — handle both shapes.
        const node =
          typeof (el.text as unknown) === "string"
            ? textNode(
                {
                  type: el.type === "mrkdwn" ? "mrkdwn" : "plain_text",
                  text: el.text as unknown as string,
                },
                "muted"
              )
            : textNode(el.text, "muted")
        if (node) children.push(node)
      }
      if (children.length === 0) return null
      return { kind: "row", children }
    }
    default:
      return null
  }
}

interface SlackMessageLike {
  blocks?: SlackBlock[]
  text?: string
}

/**
 * Minimal shape of the Events API envelope the parser stores as `event.raw`
 * (`slack/parse.ts`). A new message's blocks sit on `event`; a
 * `message_changed` edit carries the new revision on `event.message`.
 */
interface SlackEnvelopeLike {
  event?: SlackMessageLike & { subtype?: string; message?: SlackMessageLike }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Shape check that keeps the declared type (block JSON is untrusted). */
function isObject<T>(value: T | null | undefined): value is T {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Resolve the message that carries the blocks from whatever
 * `projectInboundToA2UI` handed us. Production passes the full Events API
 * envelope; tests and legacy callers pass a bare message. Slash-command
 * payloads (`command`) are not messages and have no blocks to project.
 */
function resolveSlackMessage(payload: unknown): SlackMessageLike | null {
  if (!isRecord(payload)) return null
  if (isRecord(payload.event)) {
    const event = (payload as SlackEnvelopeLike).event!
    if (event.subtype === "message_changed") {
      return isRecord(event.message) ? event.message : null
    }
    return event
  }
  if (typeof payload.command === "string") return null
  return payload as SlackMessageLike
}

/**
 * Convert a Slack message payload (the `blocks` array, optionally with a
 * fallback `text`) into an InboundA2UIBlock. Accepts the Events API envelope
 * (the production shape) or a bare message. Falls back to a single `text`
 * node when the message has no blocks.
 */
export function slackInboundToA2UI(
  payload: SlackMessageLike | SlackEnvelopeLike
): InboundA2UIBlock | null {
  const message = resolveSlackMessage(payload)
  if (!message) return null
  const blocks = Array.isArray(message.blocks) ? message.blocks : []
  const body = flatten(blocks.map(mapBlock))
  if (body.length === 0) {
    if (typeof message.text !== "string" || !message.text) return null
    return { v: 1, source: "slack", body: [{ kind: "text", text: message.text }] }
  }
  // Preserve original blocks under raw for the renderer's debug details.
  return {
    v: 1,
    source: "slack",
    body,
    raw: blocks.length > 0 ? blocks : undefined,
  }
}
