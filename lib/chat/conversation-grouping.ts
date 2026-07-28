import type { ConversationGroupBy, ConversationSidebarSettings } from "@cognia/agent-config-types"

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
