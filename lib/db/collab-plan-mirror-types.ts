/**
 * Row type for the collaboration-plane plan mirror — Dexie `collabPlans`.
 *
 * Split from the CRUD module for the same reason
 * `collab-issue-mirror-types.ts` is: `lib/db/schema.ts` needs the type to
 * declare the table, and importing the CRUD module there would make the schema
 * depend on its own accessors.
 */

import type { PlanStatus } from "@/types/agent/plan"
import type { CollabIssueActor } from "@/types/issues/collab"

/**
 * One plan as the collaboration server last reported it — the header only.
 *
 * # Why the steps are not here
 *
 * The server returns them from `GET …/plans/{id}` and omits them from the
 * listing. Mirroring them would mean one request per plan on every refresh —
 * the same fan-out the workspace rosters pay — to fill a detail view that does
 * not exist. `totalSteps`/`completedSteps` are what the activity panel renders,
 * and they arrive with the header.
 *
 * When a plan detail surface lands, this is where the steps join it, and the
 * pull gains the second request then and not before.
 */
export interface CollabPlanMirrorRow {
  /** The server's plan id (`plan_…`). Globally unique, so it is the key as-is. */
  id: string
  orgId: string
  /** The local `projectId` (ADR-0149 §1). */
  workspaceId: string
  title: string
  description?: string
  status: PlanStatus
  /** Recomputed server-side from the steps; never a number a client stated. */
  totalSteps: number
  completedSteps: number
  createdBy: CollabIssueActor
  createdAt: number
  updatedAt: number
  /** Set when the status became terminal. Absent while the plan is open. */
  endedAt?: number
  /** When this row was last pulled, so a stale panel can say so. */
  fetchedAt: number
}
