/**
 * Canvas Panel Types — UI-specific types for Canvas components.
 * Direct port from D:\Project\Cognia\types\canvas\panel.ts.
 */

import type { CanvasActionType } from "@/lib/ai/generation/canvas-actions"

export type { CollaborationConnectionState } from "./collaboration"

export interface CanvasActionItem {
  type: Exclude<CanvasActionType, "custom">
  labelKey: string
  icon: string
  shortcut?: string
}

export interface CanvasDiffLine {
  type: "added" | "removed" | "unchanged"
  content: string
  lineNumber: { old?: number; new?: number }
}

export type DocumentSortField = "title" | "updatedAt" | "language"
export type DocumentSortOrder = "asc" | "desc"

export interface FormatActionMapping {
  prefix: string
  suffix: string
}
