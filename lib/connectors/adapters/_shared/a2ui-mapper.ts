/**
 * Shared toolkit for per-platform A2UI → native rich-content mappers.
 *
 * Each platform owns its own mapper file (Slack `block-kit.ts`, Lark
 * `card.ts`, Telegram `a2ui-mapper.ts`, Discord `a2ui-mapper.ts`, OneBot
 * `a2ui-mapper.ts`) because the destination payloads are wildly different
 * shapes. What every mapper does need, though, is:
 *
 *   1. Walk the A2UI surface tree in render order (rootId → children).
 *   2. Generate a deterministic `actionId` for every interactive component
 *      so inbound callbacks round-trip back to the right surface/component.
 *   3. Persist a `ConnectorCallbackBindingRow` for each generated actionId
 *      so the parser side can recover surface/component context when the
 *      platform delivers the callback.
 *   4. Produce a `plainTextMirror` as fallback when the platform cannot
 *      render some components.
 *
 * Those four concerns live here so the five platform mappers stay focused
 * on platform-specific node shapes only.
 */

import { getDb } from "@/lib/db/schema"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import type { A2UIComponentKind } from "@/types/connectors/capability"
import type { A2UISegmentContent } from "@/types/connectors/segment"

/**
 * A component node as the mapper sees it. We accept the unknown-typed
 * `components` map from A2UISegmentContent and re-narrow to the per-node
 * fields we care about — full A2UI typing belongs to `types/a2ui/schema.ts`,
 * the mapper only needs `id`, `component`, plus children references.
 */
export interface A2UIWalkNode {
  id: string
  component: A2UIComponentKind | string
  /** The full original node payload (text, options, action, etc.). */
  raw: Record<string, unknown>
  /** Direct child ids resolved from the original `children` array. */
  childIds: string[]
}

/**
 * Walk a surface tree in render order starting from `rootId`. The visitor
 * is called for every node exactly once (cycles are short-circuited).
 *
 * Yields nodes via a callback rather than returning an array so platform
 * mappers can emit native payloads incrementally without buffering the
 * entire tree.
 */
export function walkA2UISurface(
  surface: A2UISegmentContent,
  visit: (node: A2UIWalkNode, depth: number) => void
): void {
  const { components, rootId } = surface
  const visited = new Set<string>()

  const recurse = (id: string, depth: number): void => {
    if (visited.has(id)) return
    visited.add(id)
    const raw = components[id]
    if (!raw || typeof raw !== "object") return
    const node = raw as Record<string, unknown>
    const childIds = extractChildIds(node)
    visit(
      {
        id,
        component: (typeof node.component === "string" ? node.component : "Text") as
          | A2UIComponentKind
          | string,
        raw: node,
        childIds,
      },
      depth
    )
    for (const childId of childIds) recurse(childId, depth + 1)
  }

  recurse(rootId, 0)
}

/**
 * Recover the child id list from an A2UI node. The shape differs per
 * component kind:
 *
 *   - Row / Column / Card / List / Tabs / Accordion / Drawer / Sheet /
 *     Sidebar / Collapsible: `children: string[]` (component ids).
 *   - Dialog: `body: string[]`.
 *   - ButtonGroup / RadioGroup: `options[].id` for the visual children
 *     (but options are typically inline payload, not separate components).
 *
 * Conservative default: when no recognisable child anchor exists, return
 * an empty list. Mapper-side projection still receives the `raw` node and
 * can decide to render leaves directly.
 */
function extractChildIds(node: Record<string, unknown>): string[] {
  // Common case — most layout components use `children`.
  if (Array.isArray(node.children)) {
    return node.children.filter((c): c is string => typeof c === "string")
  }
  // Dialog uses `body`.
  if (node.component === "Dialog" && Array.isArray(node.body)) {
    return (node.body as unknown[]).filter((c): c is string => typeof c === "string")
  }
  return []
}

/**
 * Generate a deterministic, namespaced action id. Used as the value the
 * platform delivers back on callback (Slack `action_id`, Telegram
 * `callback_data`, Discord `custom_id`, Lark `value.tag`).
 *
 *   `a2ui:<surfaceId>:<componentId>:<action>`
 *
 * Telegram caps `callback_data` at 64 bytes — `truncateActionId` below
 * is provided for adapters that must squeeze under that limit; they
 * SHOULD store the full id in `ConnectorCallbackBindingRow.actionId` and
 * use the truncated form on the wire.
 */
export function buildActionId(surfaceId: string, componentId: string, action: string): string {
  return `a2ui:${surfaceId}:${componentId}:${action}`
}

/**
 * Telegram-specific helper: callback_data is capped at 64 bytes. We
 * sha1-hash the long id when it exceeds the cap; the parser side uses
 * `connectorCallbackBindings.actionId` (the full string) to recover
 * surface/component context.
 */
export async function truncateActionId(
  fullId: string,
  maxBytes = 64
): Promise<{ wireId: string; isHashed: boolean }> {
  const bytes = new TextEncoder().encode(fullId)
  if (bytes.length <= maxBytes) return { wireId: fullId, isHashed: false }
  // Use Web Crypto so this works in both browser-renderer and Node test
  // environments. SHA-1 keeps the wire short (40 hex chars = 40 bytes).
  const digest = await crypto.subtle.digest("SHA-1", bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return { wireId: `a2ui:#${hex}`, isHashed: true }
}

/**
 * Persist (or update) the action_id ⇄ surface/component mapping so the
 * parser can recover context when the platform delivers a callback. Safe
 * to call multiple times for the same actionId — Dexie's `put` semantics
 * upsert by primary key.
 *
 * `conversationKey` is optional but recommended — it lets the bus scope
 * the assistant's next turn to the right ChatSession without re-deriving
 * from the callback payload.
 *
 * `kind` was added at schema v41 so the bus can distinguish ordinary
 * button/select callbacks (Slack `block_actions`, Discord
 * `MESSAGE_COMPONENT`, Lark `action_triggered_v1`, Telegram
 * `callback_query`) from ForceReply replies (Telegram) and Discord
 * modal-open buttons. Defaults to `"callback_query"` so callers in the
 * v18-v40 code path don't need to change.
 */
export async function recordCallbackBinding(input: {
  adapterId: string
  actionId: string
  surfaceId: string
  componentId?: string
  conversationKey?: string
  expiresAt?: number
  /** Defaults to `"callback_query"` — see `ConnectorCallbackBindingKind`. */
  kind?: ConnectorCallbackBindingRow["kind"]
}): Promise<void> {
  const row: ConnectorCallbackBindingRow = {
    id: `${input.adapterId}:${input.actionId}`,
    adapterId: input.adapterId,
    actionId: input.actionId,
    kind: input.kind ?? "callback_query",
    surfaceId: input.surfaceId,
    componentId: input.componentId,
    conversationKey: input.conversationKey,
    createdAt: Date.now(),
    expiresAt: input.expiresAt,
  }
  await getDb().connectorCallbackBindings.put(row)
}

/**
 * Reverse lookup: given the actionId the platform sent back, return the
 * surface/component context. Adapters call this from `parse.ts` when an
 * inbound callback arrives.
 */
export async function resolveCallbackBinding(
  adapterId: string,
  actionId: string
): Promise<ConnectorCallbackBindingRow | undefined> {
  return getDb()
    .connectorCallbackBindings.where("[adapterId+actionId]")
    .equals([adapterId, actionId])
    .first()
}

/**
 * Bulk-prune bindings older than `ttlMs` (default 14 days). Adapters can
 * call this periodically, or it runs on adapter stop. Bindings are also
 * deleted when a surface is destroyed (separate API — see Group 5).
 */
export async function pruneOldCallbackBindings(
  adapterId: string,
  ttlMs = 14 * 24 * 60 * 60 * 1000
): Promise<number> {
  const cutoff = Date.now() - ttlMs
  const stale = await getDb()
    .connectorCallbackBindings.where("adapterId")
    .equals(adapterId)
    .filter((row) => row.createdAt < cutoff && (!row.expiresAt || row.expiresAt < Date.now()))
    .primaryKeys()
  if (stale.length === 0) return 0
  await getDb().connectorCallbackBindings.bulkDelete(stale as string[])
  return stale.length
}

/**
 * Produce a plain-text projection of a surface — used as the
 * `plainTextMirror` on the outbound A2UI segment when the assistant
 * forgets to bake one in. Adapters can also call this at send-time as
 * the ultimate fallback when the platform cannot render any component
 * natively.
 *
 * Keeps a deliberately simple style — bullet list per leaf, action verbs
 * in [brackets] — so the result is legible across every channel
 * (Telegram, OneBot, raw email body, etc.).
 */
export function generatePlainTextMirror(surface: A2UISegmentContent): string {
  // Plain-text mirror is content-driven, not layout-driven — we don't
  // indent based on tree depth because pure layout containers (Column /
  // Row / Card body) are invisible in a chat channel. Visual hierarchy
  // is conveyed by semantic markers (`#` for Card titles, `[Button]` for
  // interactive verbs, `[!]` for Alerts, etc.) rather than whitespace.
  const lines: string[] = []
  walkA2UISurface(surface, (node) => {
    switch (node.component) {
      case "Text": {
        const text = stringValue(node.raw.text)
        if (text) lines.push(text)
        break
      }
      case "Button": {
        const text = stringValue(node.raw.text)
        const action = stringValue(node.raw.action)
        if (text || action) lines.push(`[${text || action}]`)
        break
      }
      case "Link": {
        const text = stringValue(node.raw.text) || stringValue(node.raw.href)
        if (text) lines.push(text)
        break
      }
      case "Image": {
        const alt = stringValue(node.raw.alt) || "image"
        lines.push(`[${alt}]`)
        break
      }
      case "Divider":
        lines.push("---")
        break
      case "Alert": {
        const title = stringValue(node.raw.title)
        const text = stringValue(node.raw.text)
        if (title || text) lines.push(`[!] ${title || ""}${title && text ? ": " : ""}${text || ""}`)
        break
      }
      case "Card": {
        const title = stringValue(node.raw.title)
        if (title) lines.push(`# ${title}`)
        break
      }
      case "Row":
      case "Column":
      case "List":
      case "Tabs":
      case "Accordion":
      case "Sheet":
      case "Drawer":
      case "Sidebar":
      case "Collapsible":
        // Layout-only — children handle the visible content.
        break
      case "TextField":
      case "TextArea": {
        const label = stringValue(node.raw.label) || stringValue(node.raw.placeholder) || "input"
        lines.push(`[${label}: __________]`)
        break
      }
      case "Checkbox": {
        const label = stringValue(node.raw.label) || "checkbox"
        lines.push(`[ ] ${label}`)
        break
      }
      case "Select":
      case "RadioGroup": {
        const label = stringValue(node.raw.label) || "select"
        const options = Array.isArray(node.raw.options)
          ? (node.raw.options as Array<Record<string, unknown>>).map(
              (o) => stringValue(o.label) || stringValue(o.value) || ""
            )
          : []
        lines.push(`${label}: ${options.filter(Boolean).join(" / ")}`)
        break
      }
      default: {
        // Unknown / specialised kinds — emit a best-effort placeholder so
        // the user can see something happened.
        lines.push(`[${node.component}]`)
      }
    }
  })
  return lines.join("\n")
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}
