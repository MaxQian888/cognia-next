/**
 * Row type for the collaboration-plane run mirror — Dexie `collabRuns`.
 *
 * Split from the CRUD module for the same reason
 * `collab-issue-mirror-types.ts` is: `lib/db/schema.ts` needs the type to
 * declare the table, and importing the CRUD module there would make the schema
 * depend on its own accessors.
 */

import type { IssueRunArtifact, IssueRunKind, IssueRunStatus } from "@/types/issues"
import type { CollabIssueActor } from "@/types/issues/collab"

/**
 * Which engine a run was dispatched to.
 *
 * `IssueRunKind` plus `plan`. The local `issueRuns` table only ever describes
 * an issue, so it has no name for a plan executing under the plan runtime; the
 * plane does, because there a plan's execution is a run like any other. The
 * union states that split rather than duplicating the three shared kinds.
 */
export type CollabRunKind = IssueRunKind | "plan"

/**
 * One dispatch as the collaboration server last reported it.
 *
 * # Why both subjects are optional and the title is not
 *
 * A run attaches to an issue, a plan, or nothing. An ad-hoc dispatch is a real
 * state and still answers "who is working in this workspace right now", so the
 * title is what carries it — a run nobody named is a row no colleague can read.
 *
 * `artifacts` are inline rather than a second table: they are the payoff of the
 * whole row (the PR link), they are small, and the server only ever sends them
 * with their run.
 */
export interface CollabRunMirrorRow {
  /** The server's run id (`run_…`). Globally unique, so it is the key as-is. */
  id: string
  orgId: string
  /** The local `projectId` (ADR-0149 §1). */
  workspaceId: string
  issueId?: string
  planId?: string
  title: string
  kind: CollabRunKind
  status: IssueRunStatus
  startedBy: CollabIssueActor
  startedAt: number
  updatedAt: number
  /** Set when the status became terminal. Absent while the run is active. */
  endedAt?: number
  summary?: string
  error?: string
  /** Always http(s) — the server refuses anything else (ADR-0149 §6). */
  artifacts: IssueRunArtifact[]
  /** When this row was last pulled, so a stale panel can say so. */
  fetchedAt: number
}
