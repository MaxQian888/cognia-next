/**
 * Federated issue types — the contract that lets one board render work items
 * that live in four different places.
 *
 * cognia already had two dnd-kit boards before the tracker existed (the Agent
 * Team board and the single-agent task board). Adding a third competing board
 * was the failure mode we explicitly designed around: instead, `/issues` is
 * the TOTAL board, and every other backend is projected into it through an
 * `IssueSourceAdapter`.
 *
 *   1. local      — Dexie `issues`. The only WRITABLE source of truth.
 *   2. github     — Dexie `githubIssueMirror` (read-only cache, slice ②)
 *   3. agent-team — `AgentTeamTask` from the agent-team store (slice ③)
 *   4. agent-task — Dexie `agentTasks` (slice ③)
 *
 * This mirrors `types/scheduler/unified.ts` + `lib/scheduler/sources/registry.ts`,
 * which already solved "six backends, one board" for the scheduler page. Copy
 * that pattern rather than inventing a second one.
 *
 * The `capabilities` bits are load-bearing: federated rows are read-only, and
 * the UI MUST honestly disable the actions they don't support rather than
 * failing at write time.
 */

import type { IssueActor, IssuePriority, IssueStatus, IssueStatusCategory } from "@/types/issues"

/** Single exhaustive runtime/type authority for every federated source. */
export const ISSUE_SOURCE_KINDS = ["local", "github", "agent-team", "agent-task"] as const

export type IssueSourceKind = (typeof ISSUE_SOURCE_KINDS)[number]

const ISSUE_SOURCE_KIND_SET: ReadonlySet<string> = new Set(ISSUE_SOURCE_KINDS)

/**
 * What the board is allowed to do with a row. Sources that don't support an
 * action set the bit to false and the UI greys the affordance out.
 */
export interface UnifiedIssueCapabilities {
  canEdit: boolean
  canMove: boolean
  canAssign: boolean
  canRun: boolean
  canComment: boolean
}

/** Local rows: everything. */
export const FULL_ISSUE_CAPABILITIES: Readonly<UnifiedIssueCapabilities> = Object.freeze({
  canEdit: true,
  canMove: true,
  canAssign: true,
  canRun: true,
  canComment: true,
})

/** Federated rows with no write path at all. */
export const READ_ONLY_ISSUE_CAPABILITIES: Readonly<UnifiedIssueCapabilities> = Object.freeze({
  canEdit: false,
  canMove: false,
  canAssign: false,
  canRun: false,
  canComment: false,
})

/** Where a row came from, and how to reach its native surface. */
export interface UnifiedIssueOrigin {
  /** Human-readable storage location (e.g. `githubIssueMirror`). */
  tableName?: string
  /** Route or URL that opens this item in its owning surface. */
  deepLinkHref: string
  /** Short badge text rendered on the card for non-local rows (e.g. "GitHub"). */
  sourceLabel?: string
}

/**
 * Normalized representation of one work item across all sources. The board
 * renderer does not know or care which backend produced it.
 */
export interface UnifiedIssueItem {
  /**
   * Stable, scope-prefixed identifier — `${kind}:${sourceId}`. Use this as the
   * React key and the dnd-kit id; never infer the kind from `sourceId` alone.
   */
  unifiedId: string
  kind: IssueSourceKind
  /** Source-native row id (Dexie pk, GitHub `owner/repo#n`, task id, …). */
  sourceId: string
  /** Printed identifier: `MERC-2` locally, `owner/repo#123` for GitHub rows. */
  identifier: string
  title: string
  description?: string
  status: IssueStatus
  statusCategory: IssueStatusCategory
  priority: IssuePriority
  assignee?: IssueActor
  /**
   * Who filed it. Drives the "Created" built-in view. Optional because some
   * federated sources have no meaningful author (an agent-team task is
   * authored by the planner, not a person).
   */
  createdBy?: IssueActor
  labelIds: string[]
  /** Delivery container, when the source knows one. */
  issueProjectId?: string
  order: number
  /** Unix epoch ms. */
  createdAt: number
  updatedAt: number
  origin: UnifiedIssueOrigin
  capabilities: UnifiedIssueCapabilities
}

/** What the board asks each source for. */
export interface IssueSourceQuery {
  /** Workspace scope — every source must honour this. */
  projectId: string
  /** Narrow to one delivery container; omitted means "all". */
  issueProjectId?: string
}

/**
 * One federated backend. Registered in `lib/issues/sources/registry.ts`.
 *
 * `list` is expected to read from local storage (Dexie / an in-memory store),
 * not from the network — network refresh is a separate concern owned by each
 * source's own sync path (for GitHub, a scheduler executor).
 */
export interface IssueSourceAdapter {
  readonly kind: IssueSourceKind
  /** Display label for the source badge and the filter menu. */
  readonly label: string
  list(query: IssueSourceQuery): Promise<UnifiedIssueItem[]>
}

/** Build a stable `unifiedId`. Centralized so sources can't drift. */
export function makeUnifiedIssueId(kind: IssueSourceKind, sourceId: string): string {
  return `${kind}:${sourceId}`
}

/**
 * Split a `unifiedId` back into its parts. Returns undefined for malformed
 * input (no colon, empty kind, empty sourceId, or an unknown kind).
 *
 * Note `sourceId` may itself contain colons (GitHub rows use `owner/repo#n`
 * and agent rows use prefixed ids), so we split on the FIRST colon only.
 */
export function parseUnifiedIssueId(
  unifiedId: string
): { kind: IssueSourceKind; sourceId: string } | undefined {
  const colonIndex = unifiedId.indexOf(":")
  if (colonIndex <= 0 || colonIndex === unifiedId.length - 1) return undefined
  const kind = unifiedId.slice(0, colonIndex)
  if (!ISSUE_SOURCE_KIND_SET.has(kind)) return undefined
  return { kind: kind as IssueSourceKind, sourceId: unifiedId.slice(colonIndex + 1) }
}

/**
 * Stable cross-source order within a column: manual `order` first (that's what
 * drag-and-drop writes), then most-recently-updated, then `unifiedId` so
 * renders are deterministic even when two sources hand back identical values.
 */
export function compareUnifiedIssues(a: UnifiedIssueItem, b: UnifiedIssueItem): number {
  if (a.order !== b.order) return a.order - b.order
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.unifiedId < b.unifiedId ? -1 : a.unifiedId > b.unifiedId ? 1 : 0
}
