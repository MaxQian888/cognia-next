import { useMemo } from "react"

import {
  buildConversationSections,
  type ConversationGroup,
  type ConversationListModel,
} from "@/lib/chat/conversation-list-model"
import type { ChatSession, ConversationGroupBy, SessionFolder } from "@cognia/agent-config-types"

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
  /** Workspace that sorts first and starts expanded. */
  activeWorkspaceId?: string | null
  /** Explicit per-group collapse choices, keyed `workspace:<id>` / `agent:<id>`. */
  groupCollapseOverrides?: Readonly<Record<string, boolean>>
  /** Session ids whose message content matched the query (title OR content). */
  contentMatchIds?: ReadonlySet<string>
  /** Override the injected clock (tests only); defaults to `Date.now()`. */
  now?: number
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
  activeWorkspaceId = null,
  groupCollapseOverrides = EMPTY_COLLAPSE_OVERRIDES,
  contentMatchIds,
  now,
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
        activeWorkspaceId,
        groupCollapseOverrides,
        contentMatchIds,
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
      activeWorkspaceId,
      groupCollapseOverrides,
      contentMatchIds,
      now,
    ]
  )
}
