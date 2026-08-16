/**
 * Issue tracker domain types (Dexie v170).
 *
 * ─── NAMING INVARIANT — read before touching anything here ───────────────
 * This repo overloads "project" and "workspace" badly (17 distinct meanings
 * of the latter). Inside the issue tracker exactly two things are named:
 *
 *   `Issue.projectId`      → the WORKSPACE. This is the repo-wide isolation
 *                            column (`lib/db/projects.ts`, user-facing label
 *                            "Workspace", `components/shell/workspace-switcher`).
 *                            Same meaning as `Goal.projectId` / `AgentPlan.projectId`.
 *
 *   `Issue.issueProjectId` → the DELIVERY CONTAINER (`IssueProject` below).
 *                            This is what the `/projects` route renders and
 *                            what the user calls a "Project" in the UI.
 *
 * They are never interchangeable. A workspace holds many issue-projects.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Shape decisions and where they come from:
 *   - `IssueActor` mirrors `ConversationOverrideRow.assignee`
 *     (`lib/db/connector-types.ts`): a non-indexed blob plus flat mirrored
 *     scalars on the row, because IndexedDB cannot index nested paths.
 *   - `IssueEvent` mirrors `GoalEvent` / `PlanEvent` / `LoopEvent`:
 *     `{ id, <fk>, kind, ts, payload }` with `payload` discriminated on
 *     `kind`, FK cascade-delete handled in the CRUD layer (never a Dexie hook).
 *   - Comments are `IssueEvent` rows (`kind: "commented"`) rather than a
 *     sixth table, so the detail panel renders one merged activity+comment
 *     timeline. Comments are append-only, matching `AgentTaskComment`.
 *   - `IssuePriority` is deliberately NOT `SubAgentPriority`
 *     (`critical|high|normal|low|background`): "background" is meaningless
 *     for a human-facing issue and the tracker needs an explicit "none".
 *     `lib/issues/run/` maps between the two at the execution boundary.
 */

/** Board columns, in display order. Fixed by design — see ADR (slice ①). */
export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const

export type IssueStatus = (typeof ISSUE_STATUSES)[number]

/**
 * The stable mapping anchor. Every cross-system projection (GitHub
 * open/closed, agent-run states, IM card buttons) maps to a *category*, never
 * to a raw column — so adding a custom column later needs no data migration
 * and no change to those three mappings.
 */
export type IssueStatusCategory = "unstarted" | "started" | "completed" | "canceled"

const STATUS_CATEGORY: Readonly<Record<IssueStatus, IssueStatusCategory>> = {
  backlog: "unstarted",
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  done: "completed",
  canceled: "canceled",
}

/** Single authority for status → category. Never inline this mapping. */
export function statusCategoryOf(status: IssueStatus): IssueStatusCategory {
  return STATUS_CATEGORY[status]
}

/** Highest → lowest. `none` sorts last everywhere. */
export const ISSUE_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const

export type IssuePriority = (typeof ISSUE_PRIORITIES)[number]

/** Sort weight for priority (lower = more urgent). `none` sinks to the bottom. */
export function priorityRank(priority: IssuePriority): number {
  return ISSUE_PRIORITIES.indexOf(priority)
}

/**
 * Who a thing belongs to. `id` is optional because the local app is
 * single-user — the human actor carries no id, exactly as
 * `ConversationOverrideRow.assignee` does.
 *
 *   human → the local user (or, on a GitHub mirror row, the GitHub login)
 *   agent → a Character / external agent id
 *   team  → an `AgentTeam` id
 */
export type IssueActorKind = "human" | "agent" | "team"

export interface IssueActor {
  kind: IssueActorKind
  id?: string
  /** Display name cached at write time so the board renders without a join. */
  label?: string
}

/** A resource attached to an issue-project. Reference-only — see below. */
export type IssueProjectResource =
  | { kind: "github-repo"; repoFullName: string; addedAt: number }
  /**
   * References a `WorkspaceRoot.id` already mounted on the owning workspace.
   * The tracker NEVER mounts a directory itself — doing so would create a
   * second directory source of truth and bypass `lib/workspace/trust-gate.ts`.
   * The "Add local directory" affordance runs the existing mount flow first,
   * then records the reference here.
   */
  | { kind: "workspace-root"; rootId: string; addedAt: number }

export const ISSUE_PROJECT_STATUSES = [
  "backlog",
  "planned",
  "in_progress",
  "paused",
  "completed",
  "canceled",
] as const

export type IssueProjectStatus = (typeof ISSUE_PROJECT_STATUSES)[number]

/** The delivery container. User-facing name: "Project". */
export interface IssueProject {
  id: string
  /** Owning workspace id — the repo-wide isolation column. */
  projectId: string
  /**
   * Human identifier prefix, 2–5 uppercase letters, globally unique.
   * Issues under this project read `<key>-<number>` (e.g. `MERC-2`).
   * Immutable after creation: changing it would orphan every printed
   * identifier already shared in commits, IM messages and PR bodies.
   */
  key: string
  name: string
  /** Shared with agents as context for every task in this project. */
  description?: string
  status: IssueProjectStatus
  priority: IssuePriority
  lead?: IssueActor
  /** Unix epoch ms. */
  startDate?: number
  targetDate?: number
  resources: IssueProjectResource[]
  /** Emoji or lucide icon name for the list/board chip. */
  icon?: string
  createdAt: number
  updatedAt: number
}

/** Link from a local issue to its GitHub counterpart. */
export interface IssueGithubRef {
  repoFullName: string
  number: number
  htmlUrl: string
}

/** The work item. Local rows are the only writable source of truth. */
export interface Issue {
  id: string
  /**
   * Printed identifier, e.g. `MERC-2`. Denormalized from
   * `<issueProject.key>-<number>` at creation so the board renders and
   * searches without a join, and so the string survives even if the project
   * row is later deleted.
   */
  identifier: string
  /** Monotonic per issue-project. Allocated in a Dexie `rw` transaction. */
  number: number
  /** Owning workspace id — the repo-wide isolation column. */
  projectId: string
  /** Owning delivery container. See the naming invariant at the top. */
  issueProjectId: string
  title: string
  description?: string
  status: IssueStatus
  /** Denormalized `statusCategoryOf(status)` — indexed for category queries. */
  statusCategory: IssueStatusCategory
  priority: IssuePriority
  /** Non-indexed blob; the two flat fields below mirror it for indexing. */
  assignee?: IssueActor
  assigneeKind?: IssueActorKind
  assigneeId?: string
  /** Who filed it. Drives the "Created" built-in view. */
  createdBy: IssueActor
  labelIds: string[]
  /** Position within its column. Renumbered 0..n-1 on reorder. */
  order: number
  /** Set when this local issue is linked to a GitHub issue. */
  githubRef?: IssueGithubRef
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  canceledAt?: number
}

/** Discriminator for the append-only issue activity trail. */
export type IssueEventKind =
  | "created"
  | "status_changed"
  | "assigned"
  | "unassigned"
  | "reassigned"
  | "priority_changed"
  | "label_added"
  | "label_removed"
  | "title_changed"
  | "description_changed"
  | "project_changed"
  | "commented"
  | "run_started"
  | "run_succeeded"
  | "run_failed"
  | "artifact_linked"
  | "github_linked"
  | "github_write_back"

/**
 * Per-kind payload. Discriminated on `kind` so the activity timeline renders
 * each entry with no runtime checks beyond the discriminator.
 */
export type IssueEventPayload =
  | { kind: "created"; by: IssueActor }
  | { kind: "status_changed"; from: IssueStatus; to: IssueStatus; by: IssueActor }
  | { kind: "assigned"; to: IssueActor; by: IssueActor }
  | { kind: "unassigned"; from: IssueActor; by: IssueActor }
  | { kind: "reassigned"; from: IssueActor; to: IssueActor; by: IssueActor }
  | { kind: "priority_changed"; from: IssuePriority; to: IssuePriority; by: IssueActor }
  | { kind: "label_added"; labelId: string; by: IssueActor }
  | { kind: "label_removed"; labelId: string; by: IssueActor }
  | { kind: "title_changed"; from: string; to: string; by: IssueActor }
  | { kind: "description_changed"; by: IssueActor }
  | { kind: "project_changed"; from: string; to: string; by: IssueActor }
  | { kind: "commented"; commentId: string; body: string; by: IssueActor }
  | { kind: "run_started"; runId: string; adapterId: string; by: IssueActor }
  | { kind: "run_succeeded"; runId: string; adapterId: string; summary?: string }
  | { kind: "run_failed"; runId: string; adapterId: string; error: string }
  | { kind: "artifact_linked"; label: string; href: string; runId?: string }
  | { kind: "github_linked"; ref: IssueGithubRef; by: IssueActor }
  | {
      kind: "github_write_back"
      action: "comment" | "label" | "close"
      ref: IssueGithubRef
      by: IssueActor
    }

/**
 * One entry in an issue's activity trail. Append-only; cascade-deleted with
 * its issue by `lib/db/issue-events.ts`, never by a Dexie hook.
 */
export interface IssueEvent {
  id: string
  issueId: string
  kind: IssueEventKind
  /** Unix epoch ms. */
  ts: number
  payload: IssueEventPayload
}

/** Monotonic identifier allocator row, one per issue-project. */
export interface IssueCounter {
  /** The `IssueProject.id` this counter belongs to. */
  scopeId: string
  /** Next number to hand out. Starts at 1. */
  next: number
}
