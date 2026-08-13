import type {
  ConversationGroupBy,
  ConversationSidebarMetadata,
  ConversationSidebarSettings,
} from "@cognia/agent-config-types"

/**
 * What the conversation list groups by when settings say nothing.
 *
 * Workspaces are the axis users actually organize work along, and the sidebar
 * already stamps every conversation with one (`ChatSession.projectId`, Dexie
 * v86). Date buckets stay one selection away.
 */
export const DEFAULT_CONVERSATION_GROUP_BY: ConversationGroupBy = "workspace"

/** Render order for the grouping selector; also the exhaustiveness list. */
export const CONVERSATION_GROUP_BY_OPTIONS: readonly ConversationGroupBy[] = [
  "workspace",
  "team",
  "date",
  "agent",
  "none",
] as const

/** Default row context: enough to identify the executor without crowding the rail. */
export const DEFAULT_CONVERSATION_SIDEBAR_METADATA: readonly ConversationSidebarMetadata[] = [
  "agent",
  "model",
] as const

/** Canonical field order used by the settings surfaces. */
export const CONVERSATION_SIDEBAR_METADATA_OPTIONS: readonly ConversationSidebarMetadata[] = [
  "agent",
  "model",
  "provider",
  "workspace",
] as const

function isGroupBy(value: unknown): value is ConversationGroupBy {
  return CONVERSATION_GROUP_BY_OPTIONS.includes(value as ConversationGroupBy)
}

/**
 * Collapse the grouping preference — current field plus the `groupByDate`
 * boolean it replaced — into one value.
 *
 * The legacy field only ever had two meanings, and only its `false` reading
 * carries information: it says "I turned grouping off". `true` was the default
 * nobody chose, so it must not pin those users to date buckets forever.
 *
 * Read sites call this instead of touching either field, so the deprecation
 * lives in exactly one place.
 */
export function resolveConversationGroupBy(
  settings: ConversationSidebarSettings | null | undefined
): ConversationGroupBy {
  if (isGroupBy(settings?.groupBy)) return settings.groupBy
  if (settings?.groupByDate === false) return "none"
  return DEFAULT_CONVERSATION_GROUP_BY
}

/**
 * Normalize a persisted row-detail list. Invalid and duplicate values are
 * dropped while the user's order is preserved.
 */
export function resolveConversationSidebarMetadata(
  settings: ConversationSidebarSettings | null | undefined
): ConversationSidebarMetadata[] {
  if (!Array.isArray(settings?.metadata)) return [...DEFAULT_CONVERSATION_SIDEBAR_METADATA]
  const valid = new Set(CONVERSATION_SIDEBAR_METADATA_OPTIONS)
  return settings.metadata.filter(
    (field, index, fields) => valid.has(field) && fields.indexOf(field) === index
  )
}

/** Toggle one row-detail field without disturbing the order of its siblings. */
export function toggleConversationSidebarMetadata(
  current: readonly ConversationSidebarMetadata[],
  field: ConversationSidebarMetadata,
  enabled: boolean
): ConversationSidebarMetadata[] {
  if (enabled) return current.includes(field) ? [...current] : [...current, field]
  return current.filter((item) => item !== field)
}
