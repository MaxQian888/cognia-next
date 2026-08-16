/**
 * Workspaces (ADR-0129): switch the active project. Reads the project store's
 * list from the context; archived workspaces are hidden unless `is:archived`.
 */

import { FolderIcon } from "lucide-react"

import { primaryRootOf } from "@/lib/workspace/roots"
import { matchTitles } from "./helpers"
import type { GlobalSearchItem, GlobalSearchProvider } from "../types"
import type { Project } from "@/types"

export const WORKSPACES_PROVIDER_ID = "builtin.workspaces"

function toItem(
  project: Project,
  activeProjectId: string | null,
  score: number,
  positions: readonly number[] = []
): GlobalSearchItem {
  const root = primaryRootOf(project)?.path
  return {
    id: `workspace:${project.id}`,
    kind: "workspace",
    title: project.name,
    titlePositions: positions,
    subtitle: root,
    icon: { lucide: FolderIcon },
    keywords: [project.id, ...(project.tags ?? [])],
    score,
    timestamp: toEpoch(project.lastAccessedAt ?? project.updatedAt),
    extra: { current: activeProjectId === project.id, archived: Boolean(project.isArchived) },
    action: { type: "switch-workspace", projectId: project.id },
  }
}

function toEpoch(value: Date | number | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

export const workspacesProvider: GlobalSearchProvider = {
  id: WORKSPACES_PROVIDER_ID,
  kind: "workspace",
  search({ query, ctx, limit }) {
    const rows = ctx.workspaces.filter((p) => query.filters.archived || !p.isArchived)
    const { hits, total, truncated } = matchTitles(rows, query.needle, {
      getTitle: (p) => p.name,
      getSecondary: (p) => primaryRootOf(p)?.path ?? p.description,
      getKeywords: (p) => [p.id, ...(p.tags ?? [])],
      getTimestamp: (p) => toEpoch(p.lastAccessedAt ?? p.updatedAt),
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) =>
        toItem(row, ctx.activeProjectId, match.score, match.positions)
      ),
      total,
      truncated,
    }
  },
  suggest({ ctx, limit }) {
    return ctx.workspaces
      .filter((p) => !p.isArchived)
      .slice()
      .sort((a, b) => (toEpoch(b.lastAccessedAt) ?? 0) - (toEpoch(a.lastAccessedAt) ?? 0))
      .slice(0, limit)
      .map((p, index) => toItem(p, ctx.activeProjectId, 1 - index / (limit + 1)))
  },
}
