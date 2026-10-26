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
export type {
  A2UIAppRow,
  A2UIEventHistoryRow,
  A2UITemplateRow,
} from "@cognia/plugin-contract/lib/db/a2ui-types"

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
  title?: string
  widget?: A2UIWidgetMetadata
  createdAt: number
  updatedAt: number
}
