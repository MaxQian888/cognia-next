import { useEffect, useMemo, useState } from "react"

import {
  buildConversationSections,
  type ConversationGroup,
  type ConversationListModel,
  type ConversationTitleScorer,
} from "@/lib/chat/conversation-list-model"
import type { ConversationFilterContext } from "@/lib/chat/conversation-filters"
import { calendarDayKey, msUntilNextCalendarDay } from "@/lib/chat/conversation-timestamp"
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
  /**
   * Emit every supplied group even when empty — for surfaces where group
   * headers are navigation entities (the merged rail's scope tree), not just
   * buckets of whatever matched. See `BuildSectionsOptions.emitEmptyGroups`.
   */
  emitEmptyGroups?: boolean
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
  /**
   * The clock the buckets are cut against; defaults to `Date.now()` at compute
   * time. Pass {@link useConversationDayClock}'s value to re-bucket exactly
   * when the calendar day turns (and keep the memo stable through the day).
   */
  now?: number
  /**
   * Zone the date buckets are cut in — the one the rows print their times in
   * (next-intl's `useTimeZone()`). Omitted = the device's local zone.
   */
  timeZone?: string
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
  emitEmptyGroups = false,
  contentMatchIds,
  searchIncludesArchived = false,
  sortBy = "recent",
  filters,
  unreadIds,
  filterContext,
  now,
  timeZone,
  scoreTitle = scoreConversationTitle,
}: UseConversationListModelParams): ConversationListModel {
  return useMemo(
    () =>
      buildConversationSections(sessions as readonly ChatSession[], folders, {
        query,
        view,
        now: resolveNow(now),
        timeZone,
        collapsedFolderIds,
        groupBy,
        workspaces,
        agents,
        teams,
        activeWorkspaceId,
        groupCollapseOverrides,
        emitEmptyGroups,
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
      emitEmptyGroups,
      contentMatchIds,
      searchIncludesArchived,
      sortBy,
      filters,
      unreadIds,
      filterContext,
      now,
      timeZone,
      scoreTitle,
    ]
  )
}

/**
 * Longest single wait of {@link useConversationDayClock}. The wait to midnight
 * is read off the wall clock, which a DST switch can put an hour out; capping
 * it (and re-checking the day on every wake) bounds that to one early wake-up.
 */
const DAY_CLOCK_MAX_WAIT_MS = 60 * 60 * 1000
/** Land just past midnight, never a hair before it. */
const DAY_CLOCK_SLACK_MS = 250

/**
 * One clock for a whole conversation list, ticking only when the calendar day
 * turns in `timeZone`.
 *
 * Everything time-shaped in the list is day-granular — the "Today / Yesterday"
 * buckets, the activity filter, a row's "14:32 / Mon / Aug 3" stamp — so a
 * finer clock would re-render the list for nothing, and none at all (a
 * `useNow()` read once per row at mount) left "14:32" standing after midnight
 * when it should have become "Mon". The value is a timestamp inside the current
 * day (the mount time, then the moment each new day was noticed); pass it as
 * the list model's `now` and down to the rows as a plain number.
 *
 * Re-checks when the window becomes visible or focused again: timers stall
 * while the machine sleeps, and a lid opened the next morning must not wait
 * out the rest of a stale timeout to show the new day.
 */
export function useConversationDayClock(timeZone?: string): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    function check() {
      const current = Date.now()
      setNow((previous) =>
        calendarDayKey(previous, timeZone) === calendarDayKey(current, timeZone)
          ? previous
          : current
      )
      schedule(current)
    }
    function schedule(from: number) {
      if (timer !== undefined) clearTimeout(timer)
      const wait = Math.min(
        msUntilNextCalendarDay(from, timeZone) + DAY_CLOCK_SLACK_MS,
        DAY_CLOCK_MAX_WAIT_MS
      )
      timer = setTimeout(check, wait)
    }
    function onWake() {
      if (document.visibilityState === "visible") check()
    }
    // First check on the next task rather than now: the zone may just have
    // changed, and the day the last reading fell on may not be today there.
    timer = setTimeout(check, 0)
    document.addEventListener("visibilitychange", onWake)
    window.addEventListener("focus", onWake)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onWake)
      window.removeEventListener("focus", onWake)
    }
  }, [timeZone])
  return now
}
