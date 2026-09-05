/**
 * Issue tracker domain types (Dexie v170 / v171 / v174 / v223 — ADR-0132).
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

/**
 * How a `github-repo` binding feeds the board (spec 2026-09-06, D1).
 *
 *   mirror  (default) read-only federated rows from `githubIssueMirror`.
 *   import  every issue becomes a local row linked through `externalRefs`,
 *           kept in step both ways by `lib/issues/sync/`.
 *
 * `projectV2Number` names the repository's Projects v2 board whose iteration
 * field populates `issueCycles` (D11). Milestones are pulled regardless.
 */
export interface GithubRepoSyncSettings {
  mode: "mirror" | "import"
  projectV2Number?: number
}

/**
 * Which Bitable column carries which issue field. Values are Bitable field
 * NAMES, never ids, because that is what `records/search` returns and what a
 * person sees in the table header. `statusValues` maps an issue status to the
 * option text a single-select column uses for it.
 */
export interface LarkBitableFieldMap {
  title: string
  description?: string
  status?: string
  statusValues?: Partial<Record<IssueStatus, string>>
  priority?: string
  assignee?: string
  dueDate?: string
  estimate?: string
}

/** A resource attached to an issue-project. Reference-only — see below. */
export type IssueProjectResource =
  | { kind: "github-repo"; repoFullName: string; addedAt: number; sync?: GithubRepoSyncSettings }
  /** A Feishu/Lark tasklist (Task v2), synced both ways through the bound adapter. */
  | {
      kind: "lark-tasklist"
      /** Bound Lark adapter instance id (`cai_...`) whose credentials to use. */
      adapterId: string
      tasklistGuid: string
      name: string
      addedAt: number
    }
  /** One table of a Feishu/Lark Bitable app, mapped column by column. */
  | {
      kind: "lark-bitable"
      adapterId: string
      appToken: string
      tableId: string
      name: string
      fieldMap: LarkBitableFieldMap
      addedAt: number
    }
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
  | {
      /** Filed from a chat session: `/issue new`, or "Save as issue" on a reply. */
      kind: "chat"
      sessionId: string
      /** The message the issue was made from, when there was one. */
      messageId?: string
    }

/** Link from a local issue to its GitHub counterpart. */
export interface IssueGithubRef {
  repoFullName: string
  number: number
  htmlUrl: string
}

/**
 * A link from a local issue (or cycle) to a record in another system.
 *
 * `githubRef` predates this and stays as the denormalised GitHub entry: the
 * github-loop adapter, the write-back dialog and the detail panel read it, and
 * `linkIssueToGithub` writes both. Everything newer (Lark tasks, Bitable rows,
 * pull requests, file imports, plugin providers) lives only here.
 *
 * `provider` is an open string on purpose. The built-ins are listed in
 * `ISSUE_EXTERNAL_PROVIDERS`; a plugin sync provider uses its own id.
 */
export interface IssueExternalRef {
  provider: string
  /** Provider-native id: `owner/repo#12`, a task guid, a record id, a row hash. */
  externalId: string
  url?: string
  label?: string
  /** Last time the sync engine reconciled this ref, in either direction. */
  syncedAt?: number
  /** The remote `updated_at` observed at that reconciliation. */
  remoteUpdatedAt?: number
  /** Provider-private cursor data (etag, revision, section). */
  meta?: Record<string, string | number>
}

export const ISSUE_EXTERNAL_PROVIDERS = [
  "github",
  "github-pr",
  "lark-task",
  "lark-bitable",
  "import:csv",
  "import:json",
  "import:markdown",
] as const

/** The lookup key an `externalRefs` entry is indexed under (`*externalKeys`). */
export function externalKeyOf(ref: Pick<IssueExternalRef, "provider" | "externalId">): string {
  return `${ref.provider}:${ref.externalId}`
}

/**
 * The `by` actor the sync engine writes with. A fourth `IssueActorKind` would
 * ripple through the assignee picker, the collab narrowing and every IM card
 * mapper for no gain, so the engine is an agent whose id carries a `sync:`
 * prefix and this is the one place that prefix is known.
 */
export const SYNC_ACTOR_ID_PREFIX = "sync:"

export function syncActorFor(provider: string, label?: string): IssueActor {
  return { kind: "agent", id: `${SYNC_ACTOR_ID_PREFIX}${provider}`, ...(label ? { label } : {}) }
}

export function isSyncActor(actor: IssueActor | undefined | null): boolean {
  return actor?.kind === "agent" && (actor.id?.startsWith(SYNC_ACTOR_ID_PREFIX) ?? false)
}

export const ISSUE_CYCLE_KINDS = ["cycle", "milestone"] as const

export type IssueCycleKind = (typeof ISSUE_CYCLE_KINDS)[number]

export const ISSUE_CYCLE_STATUSES = ["planned", "active", "completed"] as const

export type IssueCycleStatus = (typeof ISSUE_CYCLE_STATUSES)[number]

/**
 * A time box (`cycle`) or a target (`milestone`) issues are planned into.
 * One table for both: a GitHub milestone, a Projects v2 iteration and a Lark
 * tasklist section all land here, and the board groups by either the same way.
 *
 * `issueProjectId` is optional: a cycle may span every container of the
 * workspace (a team sprint) or belong to one (a repository milestone).
 */
export interface IssueCycle {
  id: string
  /** Owning workspace id. */
  projectId: string
  issueProjectId?: string
  kind: IssueCycleKind
  name: string
  description?: string
  status: IssueCycleStatus
  /** Unix epoch ms. */
  startsAt?: number
  endsAt?: number
  externalRefs: IssueExternalRef[]
  /** `externalKeyOf(ref)` per entry, multiEntry-indexed. Written by the CRUD only. */
  externalKeys: string[]
  createdAt: number
  updatedAt: number
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
  /** Parent issue id. Children render as sub-issues on the parent. */
  parentId?: string
  /**
   * Issue ids that must finish before this one should start. `blocks` is
   * derived. Optional on the type, like `externalRefs` and `externalKeys`,
   * because rows written before v223 and rows arriving over companion sync
   * from an older host carry none of the three. The CRUD always writes them
   * and `issueRelations()` in `lib/issues/relations.ts` reads them as `[]`.
   */
  blockedBy?: string[]
  /** Unix epoch ms, date precision. */
  dueDate?: number
  /** Effort in points. The unit is a display preference, never converted. */
  estimate?: number
  /** `IssueCycle.id` this issue is planned into. */
  cycleId?: string
  /** Links into other systems. `externalKeys` mirrors these for indexing. */
  externalRefs?: IssueExternalRef[]
  /** `externalKeyOf(ref)` for each entry of `externalRefs`. MultiEntry-indexed. */
  externalKeys?: string[]
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
  | "parent_changed"
  | "blocker_added"
  | "blocker_removed"
  | "due_date_changed"
  | "estimate_changed"
  | "cycle_changed"
  | "external_linked"
  | "external_unlinked"
  /** A durable work submission (a chat turn, a plan step) bound to this issue. */
  | "work_started"
  | "work_settled"
  | "synced_in"
  | "sync_conflict"
  | "sync_conflict_resolved"

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
  | { kind: "parent_changed"; from?: string; to?: string; by: IssueActor }
  | { kind: "blocker_added"; blockerId: string; by: IssueActor }
  | { kind: "blocker_removed"; blockerId: string; by: IssueActor }
  | { kind: "due_date_changed"; from?: number; to?: number; by: IssueActor }
  | { kind: "estimate_changed"; from?: number; to?: number; by: IssueActor }
  | { kind: "cycle_changed"; from?: string; to?: string; by: IssueActor }
  | { kind: "external_linked"; ref: IssueExternalRef; by: IssueActor }
  /**
   * ADR-0123 work submissions and plan steps that name this issue as their
   * `workItemRef`. `source` is the submission's source kind (`chat`, `plan`).
   */
  | { kind: "work_started"; submissionId: string; source: string; by: IssueActor }
  | { kind: "work_settled"; submissionId: string; source: string; to: string }
  | { kind: "external_unlinked"; ref: IssueExternalRef; by: IssueActor }
  /** A remote change was applied to a local field by the sync engine. */
  | { kind: "synced_in"; provider: string; field: IssueSyncField; by: IssueActor }
  /**
   * Both sides changed `field` since the last reconciliation. `winner` names
   * the side whose value now stands. `loserValue` is kept verbatim so a person
   * can put it back from the conflicts panel.
   */
  | {
      kind: "sync_conflict"
      provider: string
      field: IssueSyncField
      winner: "local" | "remote"
      localValue: unknown
      remoteValue: unknown
      by: IssueActor
    }
  /** Answers one `sync_conflict` (by its event id). */
  | {
      kind: "sync_conflict_resolved"
      conflictEventId: string
      kept: "local" | "remote"
      by: IssueActor
    }

/** The fields the sync engine reconciles. Keyed so an event can name one. */
export const ISSUE_SYNC_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "assignee",
  "labels",
  "dueDate",
  "estimate",
  "cycle",
] as const

export type IssueSyncField = (typeof ISSUE_SYNC_FIELDS)[number]

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
