/**
 * Compact tree shape used by per-adapter `inboundToA2UI` mappers.
 *
 * The full `A2UISurface` from `types/a2ui/schema.ts` is a generic protocol
 * for assistant-generated UI; persisting it back into `ChatMessage.meta`
 * pulls in a Map<string, Component> registry and dataModel — overkill for
 * one-shot inbound platform messages.
 *
 * This module declares a focused subset that covers the kinds of content
 * the five Phase 1 adapters actually emit (text, headings, images, links,
 * buttons, dividers, lists, rows/columns, cards, alerts) plus a `raw`
 * escape hatch for platform-specific fields the mapper doesn't recognise.
 *
 * Consumed by `components/chat/message-parts/inbound-a2ui-renderer.tsx`.
 */

export type InboundA2UINode =
  | { kind: "text"; text: string; emphasis?: "muted" | "bold" | "italic" | "code" }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "image"; url: string; alt?: string; width?: number; height?: number }
  | { kind: "link"; href: string; label: string }
  | {
      kind: "button"
      label: string
      /** Where pressing the button should send the operator; `url` is a hyperlink,
       *  `action_id` matches a server-side callback handler. */
      url?: string
      actionId?: string
      style?: "primary" | "danger" | "default"
    }
  | { kind: "divider" }
  | { kind: "row"; children: InboundA2UINode[] }
  | { kind: "column"; children: InboundA2UINode[] }
  | { kind: "list"; children: InboundA2UINode[]; ordered?: boolean }
  | {
      kind: "card"
      title?: string
      subtitle?: string
      children: InboundA2UINode[]
    }
  | {
      kind: "alert"
      tone: "info" | "warning" | "success" | "error"
      children: InboundA2UINode[]
    }
  | { kind: "mention"; handle: string; resolved?: string }
  | { kind: "reply_context"; replyToMessageId: string; preview?: string }
  | { kind: "raw_json"; label?: string; payload: unknown }

export interface InboundA2UIBlock {
  /** Schema discriminator for forward-compat. */
  v: 1
  /** Top-level platform identifier so the renderer can show a chip
   *  ("Slack Block Kit", "Lark Card", etc.). */
  source: "slack" | "lark" | "discord" | "telegram" | "onebot"
  /** Optional human-readable title for the rendered surface. */
  title?: string
  /** Top-level tree — the renderer walks this array in order. */
  body: InboundA2UINode[]
  /**
   * Anything from the original payload the mapper couldn't express in
   * `body`. Surfaced behind a `<details>` so operators can still see the
   * raw JSON when debugging.
   */
  raw?: unknown
}

/** Helper used by mappers to chain children safely without arrays-of-arrays. */
export function flatten(
  nodes: Array<InboundA2UINode | InboundA2UINode[] | null | undefined>
): InboundA2UINode[] {
  const out: InboundA2UINode[] = []
  for (const node of nodes) {
    if (!node) continue
    if (Array.isArray(node)) out.push(...node)
    else out.push(node)
  }
  return out
}
