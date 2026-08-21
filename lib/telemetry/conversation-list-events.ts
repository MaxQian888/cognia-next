/**
 * Behavior-telemetry emitters for the conversation list (desktop sidebar and
 * the shared filter controller the mobile list uses too).
 *
 * Thin, typed wrappers over `trackEvent` so the emit sites in the components
 * stay one line and the attribute *shaping* — the part that decides what may
 * leave the row — lives in one testable place:
 *
 *   - ids and enums only. A title, a search string, a folder or preset name is
 *     user content and never becomes an attribute; the search event carries
 *     the query's *length*, array-valued settings their *size*.
 *   - section identity is reported as its kind (`date`, `folder`, `workspace`,
 *     …), never the folder / workspace id the key embeds.
 *
 * `trackEvent` already applies the user's telemetry consent, per-category
 * switches, sampling and the PII gate, and never throws — every emitter here is
 * fire-and-forget (`void trackX(...)` at the call site).
 */

import type { ConversationSidebarSettings } from "@cognia/agent-config-types"

import { trackEvent } from "./events/track-event"
import type { ConversationListSectionKind, TelemetryEventCatalog } from "./events/catalog"

const SECTION_KINDS: ReadonlySet<ConversationListSectionKind> =
  new Set<ConversationListSectionKind>([
    "pinned",
    "folder",
    "date",
    "recent",
    "workspace",
    "agent",
    "search",
  ])

/**
 * The kind a `conversationSectionKey` denotes — the part before the first
 * `:` (`folder:f_123` → `folder`, `date:today` → `date`, `pinned` → `pinned`).
 * Unknown shapes resolve to `null` so a future section kind is dropped from
 * telemetry rather than reported under a wrong label.
 */
export function conversationSectionKindOf(sectionKey: string): ConversationListSectionKind | null {
  const kind = sectionKey.split(":", 1)[0] as ConversationListSectionKind
  return SECTION_KINDS.has(kind) ? kind : null
}

export function trackConversationOpened(
  sessionId: string,
  via: TelemetryEventCatalog["chat.list.opened"]["via"]
): Promise<boolean> {
  return trackEvent("chat.list.opened", { sessionId, via })
}

export function trackConversationCreated(kind: "direct" | "team"): Promise<boolean> {
  return trackEvent("chat.list.created", { kind })
}

export function trackConversationSearched(input: {
  /** See the catalog entry — the widened axes, never the query text. */
  scope: string
  query: string
  resultCount: number
  truncated: boolean
}): Promise<boolean> {
  return trackEvent("chat.list.searched", {
    scope: input.scope,
    // Length only — the text is the user's.
    queryLength: input.query.trim().length,
    resultCount: input.resultCount,
    truncated: input.truncated,
  })
}

/**
 * Report a drop as `from → to` inside its section. `before` is the section's
 * order at drop time, `after` the order the drop produced; the moved row is
 * the one whose position changed first from the top.
 */
export function trackConversationReordered(input: {
  sectionKey: string
  before: readonly string[]
  after: readonly string[]
  via: "pointer" | "keyboard"
}): Promise<boolean> {
  const section = conversationSectionKindOf(input.sectionKey)
  if (!section) return Promise.resolve(false)
  const from = input.before.findIndex((id, i) => id !== input.after[i])
  if (from === -1) return Promise.resolve(false)
  const to = input.after.indexOf(input.before[from]!)
  if (to === -1) return Promise.resolve(false)
  return trackEvent("chat.list.reordered", {
    section,
    from,
    to,
    size: input.before.length,
    via: input.via,
  })
}

export function trackConversationRowAction(
  action: TelemetryEventCatalog["chat.list.row.action"]["action"],
  count = 1
): Promise<boolean> {
  return trackEvent("chat.list.row.action", { action, count, bulk: count > 1 })
}

/**
 * One event per changed setting. Booleans and enums are stringified;
 * arrays report their size — `metadata` is a list of enum field names, but
 * `filterPresets` carries user-typed names, and the size is what matters for
 * both.
 */
export function trackConversationLayoutChanged(
  patch: Partial<ConversationSidebarSettings>
): Promise<boolean[]> {
  return Promise.all(
    Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([setting, value]) =>
        trackEvent("chat.list.layout.changed", {
          setting,
          value: Array.isArray(value) ? String(value.length) : String(value),
        })
      )
  )
}

export function trackConversationViewChanged(view: "active" | "archived"): Promise<boolean> {
  return trackEvent("chat.list.view.changed", { view })
}

export function trackConversationSectionToggled(
  sectionKey: string,
  collapsed: boolean
): Promise<boolean> {
  const section = conversationSectionKindOf(sectionKey)
  if (!section) return Promise.resolve(false)
  return trackEvent("chat.list.section.toggled", { section, collapsed })
}

export function trackConversationFiltered(facet: string, activeCount: number): Promise<boolean> {
  return trackEvent("chat.list.filtered", { facet, activeCount })
}
