/**
 * Issue tracker domain types (Dexie v170 / v171 / v174 — ADR-0132).
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
 *   - `IssueRun` (Dexie v174) is the issue-side record of one dispatch to an
 *     execution path (AgentTask / AgentTeam / GitHub issue loop). The issue
 *     side is the single source of truth for "which runs belong to this
 *     issue" — the execution engines are never widened with an `issueId`
 *     column, so the tracker can bind to any engine without a schema bump.
 */

/** Board columns, in display order. Fixed by design — see ADR-0132 §1. */
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
 * Who a thing belongs to.
 *
 * `id` is optional, and ADR-0132 justified that with "the local app is
 * single-user". **ADR-0149 §10 supersedes that reason.** The shape survives —
 * a board on a machine nobody has signed in on genuinely has no `usr_` to
 * write, and ADR-0149 decision 4 keeps the local product working offline — but
 * the justification is now narrower: `id` is absent because a local-only actor
 * predates any account, not because there can only ever be one person.
 *
 * The moment an issue crosses onto the collaboration plane the id is required,
 * because there "the human" names nobody. That narrowing lives in
 * `types/issues/collab.ts`, which refuses rather than inventing an id.
 *
 *   human → the local user (or, on a GitHub mirror row, the GitHub login)
 *   agent → a `Character` id (`lib/db/characters.ts`). This is what
 *           `createAgentTask` requires; external-agent ids are NOT accepted
 *           here — the run adapters refuse an id they cannot resolve rather
 *           than guess which namespace it belongs to.
 *   team  → an `AgentTeam` id (`stores/agent/agent-team-store`)
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

/**
 * Where an issue was filed from, when not the desktop board. Non-indexed and
 * additive (no schema bump). The IM origin is what lets `lib/issues/notify.ts`
 * push the issue's lifecycle back to the conversation that created it.
 */
export type IssueOrigin =
  | {
      kind: "im"
      /** Connector conversation key (`<adapterId>:<conversationRef>`). */
      conversationKey: string
      /** Platform message that was turned into (or asked for) the issue. */
      messageId?: string
    }
  | {
      kind: "browser"
      /**
       * The site the page came from — hostname only, never the path or query.
       *
       * The same rule the Browser Companion's own ledger follows: a full
       * address routinely carries session tokens and search terms, and a board
       * that renders provenance would put them on screen.
       */
      sourceHost: string
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
  /** Set when the issue was filed from an IM conversation. */
  origin?: IssueOrigin
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

/** Which execution path an `IssueRun` was dispatched to. */
export const ISSUE_RUN_KINDS = ["agent-task", "agent-team", "github-loop"] as const

export type IssueRunKind = (typeof ISSUE_RUN_KINDS)[number]

/**
 * Lifecycle of one dispatch. `queued`/`running` are "active" — an issue with an
 * active run is runtime-owned in `lib/issues/state-machine.ts`. Terminal
 * states never transition again.
 */
export const ISSUE_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const

export type IssueRunStatus = (typeof ISSUE_RUN_STATUSES)[number]

/** True for the two non-terminal run states. */
export function isActiveIssueRunStatus(status: IssueRunStatus): boolean {
  return status === "queued" || status === "running"
}

/** A produced thing worth linking from the issue: PR, branch, worktree, session. */
export interface IssueRunArtifact {
  label: string
  href: string
}

/**
 * One dispatch of an issue to an execution engine (Dexie v174, `issueRuns`).
 *
 * The row is written by `lib/issues/run/` adapters and settled by the same
 * adapters when the engine reports a terminal state. `targetId` is the
 * engine-native id (AgentTask id, AgentTeam id, integration job id) so the
 * federated sources can badge the engine's own board rows with "from KEY-1".
 */
export interface IssueRun {
  id: string
  issueId: string
  /** Owning workspace id — mirrored from the issue so workspace-wide queries need no join. */
  projectId: string
  /** `IssueRunAdapter.id` that owns this run. */
  adapterId: string
  kind: IssueRunKind
  /** Engine-native id of the dispatched work item. */
  targetId: string
  /** Secondary engine ids (e.g. the team task id for an `agent-team` run). */
  targetRef?: Record<string, string>
  status: IssueRunStatus
  /** Who pressed Run. */
  by: IssueActor
  /** Unix epoch ms. */
  startedAt: number
  updatedAt: number
  endedAt?: number
  artifacts: IssueRunArtifact[]
  /** Short outcome text from the engine (result preview, PR title, …). */
  summary?: string
  error?: string
}
