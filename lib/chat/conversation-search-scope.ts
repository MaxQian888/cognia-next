import type {
  ConversationSearchOptions,
  ConversationSearchWorkspaceReach,
  ConversationSidebarSettings,
} from "@cognia/agent-config-types"

/**
 * What the conversation-list search field reaches — the resolved half of
 * "which conversations can this query even see".
 *
 * Three axes used to be decided somewhere unrelated to search: archived rows
 * only by switching the whole list to the archived view, another workspace's
 * rows only when the *grouping* happened to be `"workspace"`, and message
 * content from a settings toggle. Each of those was a surprise in its own way —
 * the worst being that whether you could find a conversation depended on how
 * you had chosen to group the list. One control owns all three now, and a saved
 * view can carry them.
 *
 * Pure and settings-shaped so the desktop sidebar, the mobile channel list, the
 * filter controller and the saved-view resolver all read the same defaults.
 */

/** Every axis resolved, no `??` chains at the read sites. */
export type ResolvedConversationSearchOptions = Required<ConversationSearchOptions>

/** Render order for the workspace-reach selector; also the exhaustiveness list. */
export const CONVERSATION_SEARCH_WORKSPACE_OPTIONS: readonly ConversationSearchWorkspaceReach[] = [
  "current",
  "all",
] as const

/**
 * Search stays inside the active workspace, skips archived rows and matches
 * titles only — the historical behavior, and the cheapest of each axis.
 */
export const DEFAULT_CONVERSATION_SEARCH_OPTIONS: ResolvedConversationSearchOptions = Object.freeze(
  {
    workspace: "current",
    includeArchived: false,
    content: false,
  }
)

function isWorkspaceReach(value: unknown): value is ConversationSearchWorkspaceReach {
  return CONVERSATION_SEARCH_WORKSPACE_OPTIONS.includes(value as ConversationSearchWorkspaceReach)
}

/**
 * Resolve the persisted scope, folding in the legacy `searchScope` enum.
 *
 * The legacy field only ever encoded the content axis, so it seeds `content`
 * and nothing else — and only when the newer object does not say otherwise, so
 * a downgrade-then-upgrade round trip cannot resurrect a setting the user has
 * since changed. Unknown values degrade to the default rather than producing a
 * search that silently reaches nowhere.
 */
export function resolveConversationSearchOptions(
  settings: ConversationSidebarSettings | null | undefined
): ResolvedConversationSearchOptions {
  const search = settings?.search
  const legacyContent = settings?.searchScope === "titleAndContent"
  return {
    workspace: isWorkspaceReach(search?.workspace) ? search.workspace : "current",
    includeArchived: search?.includeArchived === true,
    content: search?.content ?? legacyContent,
  }
}

/**
 * Shortest query the *message* index will answer.
 *
 * Titles match from one character; message content does not, because a
 * one-character scan over every turn is noise, not a search. The two thresholds
 * differing is fine — silently degrading to title-only without saying so is
 * not, which is why this is exported rather than buried in the hook's defaults.
 */
export const CONTENT_SEARCH_MIN_QUERY = 2

/**
 * Compact, text-free description of how far a search reached — telemetry only.
 *
 * Names the widened axes, never anything the user typed. `"title"` is the
 * unwidened default and keeps the value the old enum reported, so the metric
 * stays comparable across this change.
 */
export function describeConversationSearchScope(
  options: ConversationSearchOptions | null | undefined
): string {
  const resolved = resolveConversationSearchOptions({ search: options ?? undefined })
  const parts: string[] = []
  if (resolved.content) parts.push("content")
  if (resolved.includeArchived) parts.push("archived")
  if (resolved.workspace === "all") parts.push("allWorkspaces")
  return parts.length > 0 ? parts.join("+") : "title"
}

/**
 * How many axes are widened past the default — drives the scope button's badge.
 * Each axis counts once: "all workspaces + archived" is two decisions.
 */
export function countWidenedSearchAxes(
  options: ConversationSearchOptions | null | undefined
): number {
  const resolved = resolveConversationSearchOptions({ search: options ?? undefined })
  let count = 0
  if (resolved.workspace !== DEFAULT_CONVERSATION_SEARCH_OPTIONS.workspace) count += 1
  if (resolved.includeArchived) count += 1
  if (resolved.content) count += 1
  return count
}

/**
 * Whether the session list must be loaded across every workspace.
 *
 * Two independent reasons, OR-ed: the workspace *grouping* axis is meaningless
 * over a single workspace, and a search told to reach every workspace cannot
 * find rows the query never loaded. Keeping the second one out of the grouping
 * check is the whole point — it is what made "can I find this chat?" depend on
 * how the list happened to be grouped.
 */
export function needsCrossWorkspaceSessions(
  groupBy: string | undefined,
  options: ConversationSearchOptions | null | undefined
): boolean {
  if (groupBy === "workspace") return true
  return resolveConversationSearchOptions({ search: options ?? undefined }).workspace === "all"
}
