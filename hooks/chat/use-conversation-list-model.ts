import { useMemo } from "react"

import {
  buildConversationSections,
  type ConversationGroup,
  type ConversationListModel,
  type ConversationTitleScorer,
} from "@/lib/chat/conversation-list-model"
import type { ConversationFilterContext } from "@/lib/chat/conversation-filters"
import { scoreTitleMatch } from "@/lib/global-search/scoring"
import type {
  ChatSession,
  ConversationFilters,
  ConversationGroupBy,
  ConversationSortBy,
  SessionFolder,
} from "@cognia/agent-config-types"

const EMPTY_FOLDERS: readonly SessionFolder[] = []
const EMPTY_COLLAPSED: ReadonlySet<string> = new Set<string>()
const EMPTY_GROUPS: readonly ConversationGroup[] = []
const EMPTY_COLLAPSE_OVERRIDES: Readonly<Record<string, boolean>> = {}

// Reading the wall clock is impure, so it lives in a plain module function
// (not the hook body) to keep the hook render-pure per react-hooks/purity.
// The pure model still receives `now` explicitly, so tests stay deterministic.
function resolveNow(now: number | undefined): number {
  return now ?? Date.now()
}

/**
 * Title ranking shared with ⌘K (ADR-0129): substring rank ⊕ fuzzy subsequence
 * ⊕ recency. Injected here rather than imported by the pure model, because
 * `lib/global-search/scoring.ts` already imports the model's `titleMatchRank` —
 * the hook layer is the one side of that edge that can depend on both.
 *
 * The consequence users see: typing "dply" finds "deploy" in the sidebar, and
 * the same query orders its hits the same way in both surfaces.
 */
const scoreConversationTitle: ConversationTitleScorer = (title, needle, timestamp, now) => {
  // `scoreTitleMatch` takes the needle first, and would otherwise read the wall
  // clock itself — the model's injected `now` is what keeps this deterministic.
  const match = scoreTitleMatch(needle, title, { timestamp, now })
  return match ? match.score : null
}

export interface UseConversationListModelParams {
  sessions: readonly ChatSession[]
  folders?: readonly SessionFolder[]
  /** Search text; empty/whitespace = grouped, non-empty = flat results. */
  query: string
  view?: "active" | "archived"
  collapsedFolderIds?: ReadonlySet<string>
  /** Primary grouping axis. Defaults to `"date"` (the model's own default). */
  groupBy?: ConversationGroupBy
  /** Workspaces in display order, for `groupBy: "workspace"`. */
  workspaces?: readonly ConversationGroup[]
  /** Agents in display order, for `groupBy: "agent"`. */
  agents?: readonly ConversationGroup[]
  /** Teams in display order, for `groupBy: "team"`. */
  teams?: readonly ConversationGroup[]
  /** Workspace that sorts first and starts expanded. */
  activeWorkspaceId?: string | null
  /** Explicit per-group collapse choices, keyed `workspace:<id>` / `agent:<id>`. */
  groupCollapseOverrides?: Readonly<Record<string, boolean>>
  /** Session ids whose message content matched the query (title OR content). */
  contentMatchIds?: ReadonlySet<string>
  /** Let a query reach past the archive split (search only, never browsing). */
  searchIncludesArchived?: boolean
  /** Order inside each section. Defaults to `"recent"` (the model's default). */
  sortBy?: ConversationSortBy
  /** Quick filters AND-ed on top of the archive view. Defaults to unfiltered. */
  filters?: ConversationFilters
  /** Session ids with unread messages — feeds the unread filter and sort. */
  unreadIds?: ReadonlySet<string>
  /** Model / provider fallback chain for the model + provider facets. */
  filterContext?: Pick<ConversationFilterContext, "modelOf" | "providerOf">
  /** Override the injected clock (tests only); defaults to `Date.now()`. */
  now?: number
  /**
   * Override the title ranker (tests only); defaults to the ⌘K-shared scorer.
   * Pass `null` to fall back to the model's plain substring rank.
   */
  scoreTitle?: ConversationTitleScorer | null
}

/**
 * Headless wrapper around {@link buildConversationSections}. Memoizes on the
 * real inputs and injects `now` at compute time, so the pure model stays
 * deterministic while the hook avoids recomputing on every render. Consumed by
 * both the desktop and mobile conversation lists.
 */
export function useConversationListModel({
  sessions,
  folders = EMPTY_FOLDERS,
  query,
  view = "active",
  collapsedFolderIds = EMPTY_COLLAPSED,
  groupBy = "date",
  workspaces = EMPTY_GROUPS,
  agents = EMPTY_GROUPS,
  teams = EMPTY_GROUPS,
  activeWorkspaceId = null,
  groupCollapseOverrides = EMPTY_COLLAPSE_OVERRIDES,
  contentMatchIds,
  searchIncludesArchived = false,
  sortBy = "recent",
  filters,
  unreadIds,
  filterContext,
  now,
  scoreTitle = scoreConversationTitle,
}: UseConversationListModelParams): ConversationListModel {
  return useMemo(
    () =>
      buildConversationSections(sessions as readonly ChatSession[], folders, {
        query,
        view,
        now: resolveNow(now),
        collapsedFolderIds,
        groupBy,
        workspaces,
        agents,
        teams,
        activeWorkspaceId,
        groupCollapseOverrides,
        contentMatchIds,
        searchIncludesArchived,
        sortBy,
        filters,
        unreadIds,
        filterContext,
        scoreTitle: scoreTitle ?? undefined,
      }),
    [
      sessions,
      folders,
      query,
      view,
      collapsedFolderIds,
      groupBy,
      workspaces,
      agents,
      teams,
      activeWorkspaceId,
      groupCollapseOverrides,
      contentMatchIds,
      searchIncludesArchived,
      sortBy,
      filters,
      unreadIds,
      filterContext,
      now,
      scoreTitle,
    ]
  )
}
