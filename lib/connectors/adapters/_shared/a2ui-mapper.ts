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
import type {
  CallbackActorScope,
  ConnectorCallbackBindingRow,
} from "@/types/connectors/interaction"
import type { A2UIComponentKind } from "@/types/connectors/capability"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { getComponentChildReferences } from "@/lib/a2ui/component-tree"
import { getValueByPath } from "@/lib/a2ui/data-model"

/**
 * A component node as the mapper sees it. We accept the unknown-typed
 * `components` map from A2UISegmentContent and re-narrow to the per-node
 * fields we care about — full A2UI typing belongs to `types/a2ui/schema.ts`,
 * the mapper only needs `id`, `component`, plus children references.
 */
export interface A2UIWalkNode {
  id: string
  component: A2UIComponentKind | string
  /** Node payload with display bindings resolved; callback metadata is preserved. */
  raw: Record<string, unknown>
  /** Child ids from all component collection slots and required references. */
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
    const node = resolveDisplayBindings(raw as Record<string, unknown>, surface.dataModel)
    if (node.visible === false) return
    const childIds = extractChildIds(node)
    visit(
      {
        id,
        component: (typeof node.component === "string" ? node.component : "Text") as
          A2UIComponentKind | string,
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
 * Reuse the renderer's structural references, including footer/actions,
 * nested tab/accordion bodies and step content. Keep legacy Dialog.body
 * before its actions for existing connector-generated surfaces.
 */
function extractChildIds(node: Record<string, unknown>): string[] {
  const legacyBody =
    node.component === "Dialog" && Array.isArray(node.body)
      ? node.body.filter((id): id is string => typeof id === "string")
      : []
  return [
    ...new Set([
      ...legacyBody,
      ...getComponentChildReferences(node as unknown as A2UIComponent).map((ref) => ref.id),
    ]),
  ]
}

// Only declarative display properties support bindings. In particular, an
// action's bindingPayload may contain a literal file `path` and must survive.
const BOUND_DISPLAY_FIELDS = new Set([
  "visible",
  "disabled",
  "text",
  "loading",
  "value",
  "error",
  "options",
  "checked",
  "title",
  "description",
  "image",
  "items",
  "src",
  "data",
  "selectedRows",
  "open",
  "label",
  "message",
  "activeTab",
  "pressed",
  "profileId",
  "content",
  "fallbackContent",
  "steps",
  "currentStep",
  "tableRows",
  "chartData",
  "networkNodes",
  "networkEdges",
  "plotPoints",
  "simulationConfig",
  "scenePrompt",
  "audioPrompt",
  "caption",
  "detail",
  "actionLabel",
])

function resolveDisplayBindings(
  node: Record<string, unknown>,
  dataModel: Record<string, unknown>
): Record<string, unknown> {
  const resolved = { ...node }
  for (const [key, value] of Object.entries(node)) {
    if (
      BOUND_DISPLAY_FIELDS.has(key) &&
      value &&
      typeof value === "object" &&
      "path" in value &&
      typeof value.path === "string"
    ) {
      resolved[key] = getValueByPath(dataModel, value.path)
    }
  }
  return resolved
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
/**
 * Default TTL applied to callback bindings when the caller does not pass
 * an explicit `expiresAt`. 30 days is long enough that an A2UI surface
 * the operator left open across a weekend still resolves its callbacks,
 * but short enough that the table stops growing without bound. The
 * cross-adapter daily cleanup in `callback-binding-cleanup.ts` reaps
 * any binding whose `expiresAt` has passed.
 */
export const DEFAULT_CALLBACK_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Binding hints a surface author may put on a raw interactive component, so
 * the platform mapper records the component's binding under a specific kind
 * the bus short-circuits on (`help_quick_command`, `issue_action`,
 * `ask_user`, …) instead of the default `callback_query`. Mappers spread the
 * result into `recordCallbackBinding`. Absent hints yield `{}` — every
 * existing component keeps working.
 *
 *   - `bindingKind`           → `kind`
 *   - `bindingPayload`        → `payload`
 *   - `bindingActorScope`     → `actorScope`    ({mode, allowedUserIds?})
 *   - `bindingAllowedActions` → `allowedActions` (string[])
 *   - `bindingAccountId`      → `accountId`     (string)
 *   - `bindingExpiresAt`      → `expiresAt`     (epoch ms)
 *
 * The guard fields matter for kinds whose presses mutate state: without
 * `bindingActorScope` the authorization guard falls back to per-kind legacy
 * scopes (usually "conversation"), which may be wider than intended.
 *
 * NOTE on `bindingAllowedActions`: `authorizeConnectorCallback` compares it
 * against `normalizeRequestedAction(event)` — which is platform-dependent
 * (Slack sends the action verb, Telegram/Discord echo the wire action id,
 * personal-WeChat numeric replies carry the digit). A fixed verb list is only
 * correct on verb-carrying platforms; surfaces that must work across all of
 * them (e.g. `ask_user`) should leave the hint unset and lean on actorScope.
 */
export function bindingHintFields(raw: Record<string, unknown> | undefined): {
  kind?: ConnectorCallbackBindingRow["kind"]
  payload?: Record<string, unknown>
  accountId?: string
  actorScope?: CallbackActorScope
  allowedActions?: string[]
  expiresAt?: number
} {
  if (!raw) return {}
  const kind =
    typeof raw.bindingKind === "string"
      ? (raw.bindingKind as ConnectorCallbackBindingRow["kind"])
      : undefined
  const payload =
    raw.bindingPayload &&
    typeof raw.bindingPayload === "object" &&
    !Array.isArray(raw.bindingPayload)
      ? (raw.bindingPayload as Record<string, unknown>)
      : undefined
  const accountId =
    typeof raw.bindingAccountId === "string" && raw.bindingAccountId.length > 0
      ? raw.bindingAccountId
      : undefined
  const scopeRaw = raw.bindingActorScope
  const actorScope: CallbackActorScope | undefined =
    scopeRaw &&
    typeof scopeRaw === "object" &&
    !Array.isArray(scopeRaw) &&
    ["initiator", "operators", "conversation", "anyone"].includes(
      String((scopeRaw as { mode?: unknown }).mode)
    )
      ? {
          mode: (scopeRaw as { mode: CallbackActorScope["mode"] }).mode,
          ...(Array.isArray((scopeRaw as { allowedUserIds?: unknown }).allowedUserIds)
            ? {
                allowedUserIds: (scopeRaw as { allowedUserIds: unknown[] }).allowedUserIds.filter(
                  (v): v is string => typeof v === "string"
                ),
              }
            : {}),
        }
      : undefined
  const allowedActions = Array.isArray(raw.bindingAllowedActions)
    ? (raw.bindingAllowedActions.filter(
        (v): v is string => typeof v === "string" && v.length > 0
      ) as string[])
    : undefined
  const expiresAt =
    typeof raw.bindingExpiresAt === "number" && Number.isFinite(raw.bindingExpiresAt)
      ? raw.bindingExpiresAt
      : undefined
  return {
    ...(kind ? { kind } : {}),
    ...(payload ? { payload } : {}),
    ...(accountId ? { accountId } : {}),
    ...(actorScope ? { actorScope } : {}),
    ...(allowedActions && allowedActions.length > 0 ? { allowedActions } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

export async function recordCallbackBinding(input: {
  adapterId: string
  actionId: string
  surfaceId: string
  componentId?: string
  conversationKey?: string
  /** Optional override for the createdAt stamp — defaults to `Date.now()`. */
  createdAt?: number
  /**
   * Explicit expiry. If omitted, defaults to `createdAt + 30d` so the
   * cross-adapter cleanup task can reap dead rows without the caller
   * having to think about retention.
   */
  expiresAt?: number
  /** Defaults to `"callback_query"` — see `ConnectorCallbackBindingKind`. */
  kind?: ConnectorCallbackBindingRow["kind"]
  /**
   * Free-form structured payload the bus passes to the kind-specific
   * dispatcher (schema v43). The `"skill_invoke"` kind carries
   * `{skillId, args}` here so the callback can re-fire the skill with
   * HITL bypass; `"modal_open"` may carry the platform view payload.
   */
  payload?: Record<string, unknown>
  // Callback authorization guard fields (plan 2026-07-24 Phase 2). Optional
  // pass-throughs — absent fields leave the guard on its per-kind legacy
  // fallbacks (see lib/connectors/callback-authorization.ts).
  accountId?: string
  actorScope?: CallbackActorScope
  allowedActions?: string[]
}): Promise<void> {
  const createdAt = input.createdAt ?? Date.now()
  const row: ConnectorCallbackBindingRow = {
    id: `${input.adapterId}:${input.actionId}`,
    adapterId: input.adapterId,
    actionId: input.actionId,
    kind: input.kind ?? "callback_query",
    surfaceId: input.surfaceId,
    componentId: input.componentId,
    conversationKey: input.conversationKey,
    createdAt,
    expiresAt: input.expiresAt ?? createdAt + DEFAULT_CALLBACK_BINDING_TTL_MS,
    payload: input.payload,
    accountId: input.accountId,
    actorScope: input.actorScope,
    allowedActions: input.allowedActions,
  }
  await getDb().connectorCallbackBindings.put(row)
}

/**
 * Reverse lookup: given the actionId the platform sent back, return the
 * surface/component context. Adapters call this from `parse.ts` when an
 * inbound callback arrives.
 *
 * A binding whose `expiresAt` has passed resolves as `undefined`: expiry is
 * enforced at read time, not only by the daily cleanup sweep, so a click on
 * a stale card cannot fire through a binding that is already scheduled for
 * reaping. Rows without `expiresAt` (pre-TTL legacy) never expire here.
 */
export async function resolveCallbackBinding(
  adapterId: string,
  actionId: string
): Promise<ConnectorCallbackBindingRow | undefined> {
  const row = await getDb()
    .connectorCallbackBindings.where("[adapterId+actionId]")
    .equals([adapterId, actionId])
    .first()
  if (row?.expiresAt !== undefined && row.expiresAt <= Date.now()) return undefined
  return row
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
        const text = stringValue(node.raw.message) || stringValue(node.raw.text)
        if (title || text) lines.push(`[!] ${title || ""}${title && text ? ": " : ""}${text || ""}`)
        break
      }
      case "Card": {
        const title = stringValue(node.raw.title)
        if (title) lines.push(`# ${title}`)
        const description = stringValue(node.raw.description)
        if (description) lines.push(description)
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
