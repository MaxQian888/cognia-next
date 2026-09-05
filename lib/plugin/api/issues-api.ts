/**
 * Plugin Issues API (spec 2026-09-06 D9): `ctx.issues`.
 *
 * Reads and writes go through `lib/issues/service.ts`, the same face the
 * board's bulk menu, the /issue command, the workflow nodes and the External
 * Bridge use, so a plugin is refused the same moves for the same reasons and
 * every write lands in the trail with a plugin actor. Subscriptions ride
 * `lib/issues/event-bus.ts`, which publishes after each trail write commits.
 * A plugin that speaks to another tracker registers an `IssueSyncProvider`,
 * and the engine (`lib/issues/sync/engine.ts`) pulls and pushes through it
 * exactly as it does for the built-in GitHub and Lark providers.
 *
 * Gated by `issue:read` (reads, subscriptions) and `issue:write` (mutations,
 * sync-provider registration).
 */

import { listIssueEvents } from "@/lib/db/issue-events"
import { onIssueEvent, type IssueEventListener } from "@/lib/issues/event-bus"
import {
  applyIssueAction,
  createIssueRecord,
  isIssuePriority,
  isIssueStatus,
  queryIssues,
  resolveIssue,
  toIssueWire,
  type CreateIssueRequest,
  type IssueBulkAction,
  type IssueBulkOutcome,
  type IssueQuery,
  type IssueWire,
} from "@/lib/issues/service"
import { registerIssueSyncProvider } from "@/lib/issues/sync/registry"
import type { IssueSyncProvider } from "@/lib/issues/sync/types"
import { ensureIssueLabels } from "@/lib/issues/sync/apply"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { IssueActor, IssueEvent, IssueEventKind } from "@/types/issues"

export type PluginIssueCreateInput = Omit<CreateIssueRequest, "by" | "origin">
export type PluginIssueQuery = IssueQuery

export interface PluginIssueUpdatePatch {
  title?: string
  description?: string
  status?: string
  priority?: string
  /** `null` clears. */
  dueDate?: number | null
  estimate?: number | null
  cycleId?: string | null
}

export interface PluginIssueEventOptions {
  kinds?: readonly IssueEventKind[]
  issueId?: string
}

export interface PluginIssuesAPI {
  /** By row id or printed identifier (`MERC-12`). `null` when nothing matches. */
  get(ref: string): Promise<IssueWire | null>
  list(query?: PluginIssueQuery): Promise<IssueWire[]>
  /** The trail, newest first. */
  listEvents(ref: string, limit?: number): Promise<IssueEvent[]>
  create(input: PluginIssueCreateInput): Promise<IssueWire>
  /** Each given field becomes one board action. The outcome counts them. */
  update(ref: string, patch: PluginIssueUpdatePatch): Promise<IssueBulkOutcome>
  assign(ref: string, assignee: IssueActor | null): Promise<IssueBulkOutcome>
  comment(ref: string, body: string): Promise<IssueBulkOutcome>
  /** Label NAMES. Adds create missing labels, removes never do. */
  label(
    ref: string,
    change: { add?: readonly string[]; remove?: readonly string[] }
  ): Promise<IssueBulkOutcome>
  /** Subscribe to committed trail entries. Returns the disposer. */
  onEvent(handler: IssueEventListener, options?: PluginIssueEventOptions): () => void
  /** Register an external tracker as a sync source. Returns the disposer. */
  registerSyncProvider(provider: IssueSyncProvider): () => void
}

/** The actor stamped on everything a plugin writes. */
export function pluginIssueActor(pluginId: string): IssueActor {
  return { kind: "agent", id: `plugin:${pluginId}`, label: pluginId }
}

async function requireIssue(ref: string) {
  const issue = await resolveIssue(ref)
  if (!issue) throw new Error(`No issue matches '${ref}'`)
  return issue
}

export function createIssuesAPI(pluginId: string): PluginIssuesAPI {
  const by = pluginIssueActor(pluginId)

  async function apply(
    ref: string,
    actions: readonly IssueBulkAction[]
  ): Promise<IssueBulkOutcome> {
    const issue = await requireIssue(ref)
    let applied = 0
    let skipped = 0
    let failed = 0
    let reason: IssueBulkOutcome["reason"]
    for (const action of actions) {
      const outcome = await applyIssueAction(issue, action, by)
      applied += outcome.applied
      skipped += outcome.skipped
      failed += outcome.failed
      reason ??= outcome.reason
    }
    return { applied, skipped, failed, ...(reason ? { reason } : {}) }
  }

  const api: PluginIssuesAPI = {
    get: async (ref) => {
      const issue = await resolveIssue(ref)
      return issue ? toIssueWire(issue) : null
    },
    list: async (query = {}) => (await queryIssues(query)).map(toIssueWire),
    listEvents: async (ref, limit = 100) => {
      const issue = await requireIssue(ref)
      return listIssueEvents({ issueId: issue.id, descending: true, limit })
    },
    create: async (input) => toIssueWire(await createIssueRecord({ ...input, by })),
    update: async (ref, patch) => {
      const actions: IssueBulkAction[] = []
      if (typeof patch.title === "string" && patch.title.trim()) {
        actions.push({ kind: "title", to: patch.title.trim() })
      }
      if (typeof patch.description === "string") {
        actions.push({ kind: "description", to: patch.description })
      }
      if (patch.status !== undefined) {
        if (!isIssueStatus(patch.status)) throw new Error(`Unknown status '${patch.status}'`)
        actions.push({ kind: "status", to: patch.status })
      }
      if (patch.priority !== undefined) {
        if (!isIssuePriority(patch.priority))
          throw new Error(`Unknown priority '${patch.priority}'`)
        actions.push({ kind: "priority", to: patch.priority })
      }
      if (patch.dueDate !== undefined) actions.push({ kind: "dueDate", to: patch.dueDate })
      if (patch.estimate !== undefined) actions.push({ kind: "estimate", to: patch.estimate })
      if (patch.cycleId !== undefined) actions.push({ kind: "cycle", cycleId: patch.cycleId })
      if (actions.length === 0) throw new Error("Nothing to change")
      return apply(ref, actions)
    },
    assign: (ref, assignee) => apply(ref, [{ kind: "assignee", to: assignee }]),
    comment: (ref, body) => {
      const trimmed = body.trim()
      if (!trimmed) throw new Error("Comment body is required")
      return apply(ref, [{ kind: "comment", body: trimmed }])
    },
    label: async (ref, change) => {
      const actions: IssueBulkAction[] = []
      for (const row of await ensureIssueLabels(change.add ?? [])) {
        actions.push({ kind: "addLabel", labelId: row.id })
      }
      if (change.remove?.length) {
        const { listLabels } = await import("@/lib/db/labels")
        const wanted = new Set(change.remove.map((name) => name.trim().toLowerCase()))
        for (const row of await listLabels("issue")) {
          if (wanted.has(row.name.toLowerCase()))
            actions.push({ kind: "removeLabel", labelId: row.id })
        }
      }
      if (actions.length === 0) throw new Error("Give label names to add or remove")
      return apply(ref, actions)
    },
    onEvent: (handler, options) => onIssueEvent(handler, options),
    registerSyncProvider: (provider) => {
      if (!provider?.id?.trim()) throw new Error("A sync provider needs an id")
      return registerIssueSyncProvider(provider)
    },
  }

  return createGuardedAPI(pluginId, api, {
    get: "issue:read",
    list: "issue:read",
    listEvents: "issue:read",
    onEvent: "issue:read",
    create: "issue:write",
    update: "issue:write",
    assign: "issue:write",
    comment: "issue:write",
    label: "issue:write",
    registerSyncProvider: "issue:write",
  })
}
