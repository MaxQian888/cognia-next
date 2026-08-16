/**
 * Host-provided lists (ADR-0129): workbench panels of the workbench in front,
 * and plugin quick actions registered for the palette surface. Both arrive
 * pre-resolved on the context (labels translated, `when` clauses evaluated by
 * the dialog's hooks), so these providers are pure projections.
 */

import { PanelRightIcon, PuzzleIcon } from "lucide-react"

import { matchTitles } from "./helpers"
import type { GlobalSearchProvider } from "../types"

export const WORKBENCH_PANELS_PROVIDER_ID = "builtin.workbench-panels"
export const PLUGIN_ACTIONS_PROVIDER_ID = "builtin.plugin-actions"

export const workbenchPanelsProvider: GlobalSearchProvider = {
  id: WORKBENCH_PANELS_PROVIDER_ID,
  kind: "workbench-panel",
  search({ query, ctx, limit }) {
    const { hits, total, truncated } = matchTitles(ctx.host.workbenchPanels, query.needle, {
      getTitle: (p) => p.label,
      getKeywords: (p) => [p.id, p.activity ?? ""],
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) => ({
        id: `workbench-panel:${row.id}`,
        kind: "workbench-panel" as const,
        title: row.label,
        titlePositions: match.positions,
        meta: row.activity,
        icon: { lucide: PanelRightIcon },
        score: match.score,
        action: { type: "reveal-panel" as const, panelId: row.id },
      })),
      total,
      truncated,
    }
  },
}

export const pluginActionsProvider: GlobalSearchProvider = {
  id: PLUGIN_ACTIONS_PROVIDER_ID,
  kind: "plugin-action",
  search({ query, ctx, limit }) {
    const { hits, total, truncated } = matchTitles(ctx.host.pluginQuickActions, query.needle, {
      getTitle: (a) => a.title,
      getSecondary: (a) => a.description,
      getKeywords: (a) => [a.fullId, a.pluginId],
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) => ({
        id: `plugin-action:${row.fullId}`,
        kind: "plugin-action" as const,
        title: row.title,
        titlePositions: match.positions,
        subtitle: row.description?.trim() || undefined,
        meta: row.pluginId,
        icon: { lucide: PuzzleIcon },
        score: match.score,
        action: { type: "quick-action" as const, entry: row },
      })),
      total,
      truncated,
    }
  },
}
