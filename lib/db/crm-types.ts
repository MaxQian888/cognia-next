/**
 * Row types for the connector CRM tables (schema v83) — conversation labels,
 * assignment-event trail, and the canned-responses library. Co-located with
 * their CRUD modules per `lib/db/CONVENTIONS.md` and re-exported from
 * `@/lib/db/schema` so that stays the stable import surface.
 *
 * The lifecycle / assignee / label / SLA *fields* live on
 * `ConversationOverrideRow` (connector-types.ts); only the catalogs and the
 * append-only event trail get their own tables.
 */

import type { LabelRow } from "@/types/labels"

/**
 * A reusable conversation label/tag (Chatwoot-style).
 *
 * As of schema v170 this is an alias of the shared `LabelRow` catalogue
 * (`types/labels`): the rows moved from the `conversationLabels` table into
 * the scope-discriminated `labels` table with their ids preserved, so
 * `ConversationOverrideRow.labelIds[]` and `CannedResponseRow.labelIds[]` keep
 * resolving untouched. The alias is kept so every existing import of
 * `ConversationLabelRow` still compiles; new code should import `LabelRow`.
 */
export type ConversationLabelRow = LabelRow

/** Discriminator for the append-only conversation event trail. */
export type AssignmentEventKind =
  | "assigned"
  | "unassigned"
  | "reassigned"
  | "status.open"
  | "status.pending"
  | "status.snoozed"
  | "status.resolved"
  | "label.added"
  | "label.removed"

/**
 * One entry in a conversation's assignment / status / label history. Capped
 * per-conversation by the CRUD layer (mirrors `connector-audit` pruning).
 */
export interface ConversationAssignmentEventRow {
  id: string
  conversationKey: string
  kind: AssignmentEventKind
  at: number
  /** Free-form context: { assignee, fromStatus, toStatus, labelId, via, ... }. */
  fields?: Record<string, unknown>
}

/**
 * A saved/canned reply with `{{variable}}` interpolation. Distinct from the
 * per-adapter quick-commands (those are inbound text triggers); these are
 * operator-inserted outbound templates available across every conversation.
 */
export interface CannedResponseRow {
  id: string
  title: string
  body: string
  category?: string
  /** Optional shortcut token (e.g. "/greet") for quick filtering in the picker. */
  shortcut?: string
  /** Labels for grouping in the picker; multi-entry indexed via `*labelIds`. */
  labelIds?: string[]
  /** Seeded starter templates cannot be deleted. */
  isBuiltIn?: boolean
  sortOrder: number
  /** Usage counter incremented each time the response is inserted. */
  usageCount?: number
  createdAt: number
  updatedAt: number
}
