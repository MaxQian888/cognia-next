/**
 * Search action nodes: `action.search.query` and `action.search.messages`
 * (ADR-0129).
 *
 * `query` runs the same engine and the same providers the command palette
 * does, through `buildHeadlessSearchContext` rather than the dialog's ten
 * hooks. `messages` runs `searchChatHistory`, which takes no
 * `GlobalSearchContext` at all and is therefore the one search node that stays
 * honest even on a standalone browser.
 *
 * Neither declares `requires`. Search is a read over whichever local database
 * the shell owns, and a provider that cannot answer here returns an empty
 * group rather than failing, which is already the right behaviour.
 *
 * No PII gate. Search output is app-local, and it becomes an egress concern
 * only when a downstream `ai.*` or `action.agent.turn` node consumes it, where
 * `runtime/egress-guard.ts` already deep-checks the whole value. A second gate
 * would only be a second place to keep correct.
 */

import { parseGlobalSearchQuery } from "@/lib/global-search/query-parser"
import {
  runGlobalSearch,
  SCOPED_GROUP_LIMIT,
  type RunGlobalSearchOptions,
} from "@/lib/global-search/engine"
import {
  buildHeadlessSearchContext,
  WORKFLOW_SEARCHABLE_KINDS,
} from "@/lib/global-search/headless-context"
import { providersForKinds } from "@/lib/global-search/registry"
import type {
  GlobalSearchAction,
  GlobalSearchItem,
  GlobalSearchKind,
} from "@/lib/global-search/types"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"

/** Total items across every group. A result set is not a payload. */
const TOTAL_ITEM_CEILING = 100

function params(ctx: StepExecutionContext): Record<string, unknown> {
  return ctx.params as Record<string, unknown>
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key]
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function bool(p: Record<string, unknown>, key: string): boolean | undefined {
  return typeof p[key] === "boolean" ? (p[key] as boolean) : undefined
}

function int(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key]
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined
}

/**
 * Reduce an action to something a downstream node can read.
 *
 * `{ type: "callback", run }` carries a function and `reveal-panel` a UI
 * intent, so both come back as their kind and nothing else. The result is a
 * target, not an invocation. A graph acts through the node for that entity.
 */
function toTarget(action: GlobalSearchAction | undefined): Record<string, unknown> | undefined {
  if (!action) return undefined
  const a = action as unknown as Record<string, unknown>
  const target: Record<string, unknown> = { type: a.type }
  for (const key of ["sessionId", "href", "workspaceId", "id", "messageId"]) {
    if (typeof a[key] === "string") target[key] = a[key]
  }
  return target
}

function toItem(item: GlobalSearchItem, kind: GlobalSearchKind) {
  return {
    id: item.id,
    kind,
    title: item.title,
    subtitle: item.subtitle,
    score: item.score,
    timestamp: item.timestamp,
    target: toTarget(item.action),
  }
}

registerNodeExecutor({
  kind: "action.search.query",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const raw = str(p, "query")
    if (!raw) throw nonRetryable("action.search.query requires 'query'")

    const requested = Array.isArray(p.kinds)
      ? (p.kinds as unknown[]).filter(
          (k): k is GlobalSearchKind =>
            typeof k === "string" && (WORKFLOW_SEARCHABLE_KINDS as readonly string[]).includes(k)
        )
      : []
    const kinds = requested.length > 0 ? requested : WORKFLOW_SEARCHABLE_KINDS
    const searchAllWorkspaces = str(p, "workspaceScope") === "all"

    const context = await buildHeadlessSearchContext({
      // `current` binds to the run's workspace (ADR-0144). `all` is an
      // explicit choice, and the output says which one was used.
      activeProjectId: searchAllWorkspaces ? null : (str(p, "projectId") ?? ctx.projectId),
      now: Date.now(),
    })

    const options: RunGlobalSearchOptions = {
      limit: Math.min(Math.max(int(p, "limit") ?? 10, 1), SCOPED_GROUP_LIMIT),
      // An explicit provider list rather than the scope's default, so the
      // UI-only kinds cannot come back through a widened scope later.
      providers: providersForKinds(kinds),
      signal: ctx.signal,
    }
    const outcome = await runGlobalSearch(
      parseGlobalSearchQuery(raw, { now: Date.now() }),
      context,
      options
    )

    let remaining = TOTAL_ITEM_CEILING
    let cappedByTotal = false
    const groups: Array<Record<string, unknown>> = []
    for (const group of outcome.groups) {
      if (remaining <= 0) {
        cappedByTotal = true
        break
      }
      const items = group.items.slice(0, remaining)
      if (items.length < group.items.length) cappedByTotal = true
      remaining -= items.length
      if (group.truncated) cappedByTotal = true
      groups.push({
        kind: group.kind,
        providerId: group.providerId,
        items: items.map((item) => toItem(item, group.kind)),
        // The group's own count, which is what `totalHits` sums, so an author
        // can see how much a per-kind limit withheld.
        total: group.total,
        truncated: group.truncated,
        coverage: group.coverage,
        // A provider that threw becomes an errored group, never a failed run.
        error: group.error,
      })
    }

    const itemCount = groups.reduce((n, g) => n + (g.items as unknown[]).length, 0)
    // Counts only. The result set travels on the output, which the expression
    // resolver reads, while the event log gets a line.
    ctx.log(
      "info",
      `search: ${groups.length} groups, ${itemCount} items, coverage=${outcome.coverage}`
    )

    return {
      output: {
        query: raw,
        workspaceScope: searchAllWorkspaces ? "all" : "current",
        groups,
        itemCount,
        totalHits: outcome.totalHits,
        coverage: outcome.coverage,
        // True when any group hit its own per-kind limit, or when the total
        // ceiling stopped this node before the groups ran out.
        truncated: cappedByTotal,
        tookMs: outcome.tookMs,
        aborted: outcome.aborted,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.search.messages",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const query = str(p, "query")
    if (!query) throw nonRetryable("action.search.messages requires 'query'")

    const { searchChatHistory } = await import("@/lib/chat/search/engine")
    const limit = Math.min(Math.max(int(p, "limit") ?? 20, 1), 200)
    const roles = Array.isArray(p.roles)
      ? (p.roles as unknown[]).filter((r): r is string => typeof r === "string")
      : undefined
    const searchAllWorkspaces = str(p, "workspaceScope") === "all"

    const outcome = await searchChatHistory({
      query,
      limit,
      // Scoped to the run's workspace unless the node widens it, matching
      // `action.search.query` and ADR-0144.
      projectId: searchAllWorkspaces ? undefined : (str(p, "projectId") ?? ctx.projectId),
      includeArchived: bool(p, "includeArchived") ?? false,
      collapseBySession: bool(p, "collapseBySession") ?? false,
      ...(roles && roles.length > 0 ? { roles } : {}),
    })

    return {
      output: {
        query,
        workspaceScope: searchAllWorkspaces ? "all" : "current",
        matches: outcome.results.map((r) => ({
          messageId: r.messageId,
          sessionId: r.sessionId,
          sessionTitle: r.sessionTitle,
          projectId: r.projectId,
          role: r.role,
          createdAt: r.createdAt,
          score: r.score,
          archived: r.archived,
          // The excerpt only. `positions` indexes into it for a highlight
          // component, which is not something a downstream node can use.
          snippet: r.snippet.text,
        })),
        matchCount: outcome.results.length,
        // Two different reasons a result set is short, and they resolve
        // differently: one by asking for more, the other by waiting.
        moreOlderHistory: outcome.moreOlderHistory,
        indexIncomplete: outcome.indexIncomplete,
      },
    }
  },
})
