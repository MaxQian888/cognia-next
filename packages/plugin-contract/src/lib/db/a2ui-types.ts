/**
 * The plugin contract's share of `lib/db/a2ui-types.ts`, which re-exports these.
 */
import type { A2UIAppInstance } from "../../hooks/a2ui/app-builder/types"
import type { A2UIComponent, A2UIWidgetMetadata } from "../../types/a2ui/schema"

/**
 * Persisted mini-app — extends Cognia's A2UIAppInstance with the shape
 * fields the renderer needs to recreate a surface from a saved app.
 *
 * Built-in apps are seeded by `lib/db/seed.ts` and protected against
 * destructive edits by the CRUD layer.
 */
export interface A2UIAppRow extends A2UIAppInstance {
  /** Components tree, keyed by component id. */
  components: Record<string, A2UIComponent>
  /** Initial dataModel for fresh instances. */
  dataModel: Record<string, unknown>
  /** Root component id for the surface render. */
  rootId: string
  /** Catalog choice (e.g. cognia-academic, financial, general). */
  catalogId?: string
  /** Optional widget metadata (host strategy, sizing, theme). */
  widget?: A2UIWidgetMetadata
  /** Built-in / read-only marker. */
  isBuiltIn?: boolean
  /** UI flag — appears in the favorites filter. */
  isFavorite?: boolean
  /** Manual sort order in the Hub gallery. */
  sortOrder?: number
  /** Aggregate usage count (incremented on instantiate). */
  usageCount?: number
  /** ms since epoch — last instantiation. */
  lastUsedAt?: number
  /** ms since epoch — last edit. */
  updatedAt: number
}

/**
 * User-defined template row (additional templates beyond the 14 built-in
 * ones in `lib/a2ui/templates/`). Built-in templates do **not** live here —
 * they're static.
 */
export interface A2UITemplateRow {
  id: string
  name: string
  category: string
  description?: string
  components: A2UIComponent[]
  dataModel: Record<string, unknown>
  rootId: string
  isBuiltIn: false
  source: "user" | "imported"
  thumbnailUrl?: string
  createdAt: number
  updatedAt: number
}

/**
 * One row per user action / data-model change for the Debugger tab.
 * Insertion is best-effort and capped at 1000 rows by the CRUD layer.
 */
export interface A2UIEventHistoryRow {
  id: string
  surfaceId: string
  type: "userAction" | "dataModelChange"
  payload: Record<string, unknown>
  timestamp: number
}
