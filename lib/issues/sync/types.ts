/**
 * The contract between the sync engine and a provider (spec 2026-09-06, D1).
 *
 * A provider knows one remote system: how to find its bindings among a
 * container's resources, how to read what changed, and how to write a patch
 * back. It knows nothing about Dexie, events, conflicts or the board. The
 * engine (`./engine.ts`) owns all of that, so a Lark tasklist, a GitHub
 * repository and a plugin's Jira instance all reconcile the same way.
 */

import type {
  Issue,
  IssueActor,
  IssueCycleKind,
  IssueCycleStatus,
  IssueExternalRef,
  IssuePriority,
  IssueProject,
  IssueProjectResource,
  IssueStatus,
  IssueSyncField,
} from "@/types/issues"

/** One remote container bound to one local container. */
export interface IssueSyncBinding {
  providerId: string
  /** Owning workspace id. */
  projectId: string
  issueProjectId: string
  /** The container's key, for identifier parsing (PR bodies name `KEY-12`). */
  projectKey: string
  resource: IssueProjectResource
  /**
   * Stable per (provider, remote container). Stamped on every ref's
   * `meta.binding` so the engine can compute a per-binding watermark and a
   * provider can tell its own refs apart from another binding's.
   */
  key: string
}

/** A remote work item, normalised to the board's own vocabulary. */
export interface RemoteIssue {
  externalId: string
  url?: string
  /** Short printed form (`owner/repo#12`, a task title). Cached on the ref. */
  label?: string
  title: string
  description?: string
  status: IssueStatus
  /**
   * The remote only knows open versus closed (GitHub, a Lark task). The
   * engine then compares `status` by category, so a local `in_progress` is
   * not dragged back to `todo` on every pull of an open item.
   */
  coarseStatus?: boolean
  priority?: IssuePriority
  /** Display name of the remote assignee, when there is one. */
  assigneeLabel?: string | null
  /** Label NAMES. The engine resolves them to local rows by name. */
  labels?: readonly string[]
  dueDate?: number | null
  estimate?: number | null
  /** `RemoteCycle.externalId` the item is planned into, `null` for none. */
  cycleExternalId?: string | null
  /** Remote `updated_at`, epoch ms. The engine's clock for D2. */
  remoteUpdatedAt: number
  /** Provider-private data to keep on the ref (`etag`, node ids). */
  meta?: Record<string, string | number>
}

/** A remote milestone, iteration or section, normalised to `issueCycles`. */
export interface RemoteCycle {
  externalId: string
  kind: IssueCycleKind
  name: string
  status?: IssueCycleStatus
  startsAt?: number
  endsAt?: number
  url?: string
}

/**
 * A pull request or merge request that names issues. The engine links it as
 * a `github-pr`-style ref on every issue it mentions (D11).
 */
export interface RemoteLink {
  provider: string
  externalId: string
  url?: string
  label?: string
  /** Local identifiers (`KEY-12`) and remote issue ids the link mentions. */
  mentionsIdentifiers: readonly string[]
  mentionsExternalIds: readonly string[]
}

export interface PullOptions {
  /** Epoch ms watermark. Absent means everything. */
  since?: number
  /** Ignore the watermark and read everything again. */
  full?: boolean
}

export interface PullResult {
  items: RemoteIssue[]
  cycles?: RemoteCycle[]
  links?: RemoteLink[]
  /** True when the remote answered "nothing changed" and `items` is empty. */
  notModified: boolean
  /** True when a page cap stopped the read before the remote ran out. */
  truncated?: boolean
}

/** The fields the engine wants written back, already in remote-neutral form. */
export interface RemotePatch {
  title?: string
  description?: string | null
  status?: IssueStatus
  priority?: IssuePriority
  labels?: readonly string[]
  dueDate?: number | null
  estimate?: number | null
  /** Local cycle's ref for this provider, when one exists, else `null`. */
  cycleExternalId?: string | null
}

export type PushOutcome =
  /** The remote accepted the write. */
  | { status: "applied"; remoteUpdatedAt?: number }
  /**
   * The write was queued behind an approval gate (an integration action job).
   * The engine leaves the ref untouched, so the next pass pushes again with
   * the same idempotency key and the job is deduplicated upstream.
   */
  | { status: "queued"; jobId?: string }

export interface IssueSyncProvider {
  readonly id: string
  readonly label: string
  /** Fields the engine may take FROM the remote. */
  readonly pullFields: readonly IssueSyncField[]
  /** Fields the engine may send TO the remote. Empty means read-only. */
  readonly pushFields: readonly IssueSyncField[]
  /** Which resource kind(s) this provider binds. */
  resolveBindings(containers: readonly IssueProject[]): IssueSyncBinding[]
  pull(binding: IssueSyncBinding, options: PullOptions): Promise<PullResult>
  push?(
    binding: IssueSyncBinding,
    ref: IssueExternalRef,
    patch: RemotePatch,
    issue: Issue,
    context: { idempotencyKey: string; by: IssueActor }
  ): Promise<PushOutcome>
  /** Create the remote counterpart of a local issue. Manual, never automatic. */
  create?(binding: IssueSyncBinding, issue: Issue): Promise<IssueExternalRef>
}

export interface ReconcileOutcome {
  binding: IssueSyncBinding
  created: number
  updated: number
  pushed: number
  queued: number
  conflicts: number
  linked: number
  cycles: number
  notModified: boolean
  truncated: boolean
}

export interface IssueSyncFailure {
  binding: IssueSyncBinding
  error: unknown
}
