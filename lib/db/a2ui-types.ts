// Dexie row types for the A2UI subsystem (schema v13).
//
// Surfaces split into two concepts:
//
//   - "App" rows  (`a2uiApps`)    — user-saved mini-app definitions, the
//                                   stable artefact users create in the Hub.
//                                   Aliased onto Cognia's existing
//                                   `A2UIAppInstance` so the app-builder
//                                   hook tree keeps working unchanged.
//
//   - "Surface" rows (`a2uiSurfaces`) — persisted runtime surfaces (panel /
//                                   fullscreen only; inline surfaces stay
//                                   in-memory). Used to restore a panel
//                                   after window reload without making the
//                                   model re-emit the full components tree.
//
//   - "Template" rows (`a2uiTemplates`) — user-defined templates layered on
//                                   top of the 14 built-in templates that
//                                   the static `lib/a2ui/templates/` module
//                                   ships.
//
//   - "Event-history" rows (`a2uiEventHistory`) — capped audit trail for
//                                   the Settings → A2UI → Debugger tab.

import type { A2UIComponent, A2UISurfaceType, A2UIWidgetMetadata } from "@/types/a2ui/schema"
import type { A2UIAppInstance } from "@/hooks/a2ui/app-builder/types"

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
 * Persisted runtime surface. Only `panel` / `fullscreen` types are saved
 * here — `inline` surfaces are tied to a chat message and the message
 * itself acts as the persistence boundary.
 */
export interface A2UISurfaceRow {
  id: string
  /** Source app id when the surface was instantiated from a saved app. */
  appId?: string
  /** Chat session id — surfaces tied to a session reload with the chat. */
  sessionId?: string
  type: A2UISurfaceType
  components: Record<string, A2UIComponent>
  dataModel: Record<string, unknown>
  rootId: string
  catalogId?: string
  widget?: A2UIWidgetMetadata
  createdAt: number
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
