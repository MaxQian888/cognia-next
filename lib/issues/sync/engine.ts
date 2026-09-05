/**
 * Reconcile one binding (spec 2026-09-06, D1 and D2).
 *
 * For every remote item the provider reports:
 *   - no local issue carries its ref: create one (import) with the ref.
 *   - a local issue carries it: compare field by field.
 *       remote changed since the ref's last sync  = remoteUpdatedAt > syncedAt
 *       local changed since then                  = last non-sync event on that field
 *       both                                      = conflict, newer side wins (D2),
 *                                                   the loser is recorded as an event
 *       only remote                               = apply remote
 *       only local                                = push (below)
 *       first reconciliation (no syncedAt)        = remote is authoritative
 *
 * Then, for every local issue with a ref on this binding, the fields a person
 * changed since the last sync and that the remote did not overwrite go to the
 * provider's `push` in one patch. A queued push (approval gate) leaves the ref
 * untouched so the next pass repeats it under the same idempotency key.
 *
 * Cycles come first so `cycleIdOf` can resolve while items are applied.
 * Links (pull requests) come last and only add refs.
 */

import {
  createIssue,
  getIssueByExternalKey,
  linkIssueExternal,
  mapIssuesByExternalProvider,
  touchIssueExternalRef,
} from "@/lib/db/issues"
import {
  createIssueCycle,
  getIssueCycleByExternalKey,
  listIssueCycles,
  updateIssueCycle,
} from "@/lib/db/issue-cycles"
import { listIssueEvents } from "@/lib/db/issue-events"
import { hasActiveIssueRun } from "@/lib/db/issue-runs"
import { listLabels } from "@/lib/db/labels"
import { getDb } from "@/lib/db/schema"
import { appendIssueEvent } from "@/lib/db/issue-events"
import type { Issue, IssueExternalRef, IssueStatus, IssueSyncField } from "@/types/issues"
import { externalKeyOf, ISSUE_SYNC_FIELDS, statusCategoryOf, syncActorFor } from "@/types/issues"
import type { LabelRow } from "@/types/labels"
import {
  applyRemoteField,
  ensureIssueLabels,
  fieldValuesDiffer,
  localFieldValue,
  remoteFieldValue,
  type RemoteFieldValue,
} from "./apply"
import { lastLocalChangeAt } from "./field-clock"
import type {
  IssueSyncBinding,
  IssueSyncProvider,
  ReconcileOutcome,
  RemoteCycle,
  RemoteIssue,
  RemoteLink,
  RemotePatch,
} from "./types"

export interface ReconcileOptions {
  full?: boolean
  now?: () => number
}

/**
 * What a remote that only knows open versus closed can tell apart. `todo` and
 * `in_progress` are both "open" to it, so a coarse compare treats them as one.
 */
export function coarseStatusBucket(status: IssueStatus): "open" | "done" | "canceled" {
  const category = statusCategoryOf(status)
  if (category === "completed") return "done"
  if (category === "canceled") return "canceled"
  return "open"
}

/** Stable per (issue, patch) so a re-queued push deduplicates upstream. */
export function pushIdempotencyKey(issueId: string, patch: RemotePatch): string {
  const body = JSON.stringify(patch, Object.keys(patch).sort())
  let hash = 0
  for (let i = 0; i < body.length; i += 1) hash = (hash * 31 + body.charCodeAt(i)) | 0
  return `issue-sync:${issueId}:${(hash >>> 0).toString(16)}`
}

/** The newest `remoteUpdatedAt` this binding has already seen, or undefined. */
export async function bindingWatermark(binding: IssueSyncBinding): Promise<number | undefined> {
  const rows = await mapIssuesByExternalProvider(binding.providerId, binding.projectId)
  let max: number | undefined
  for (const issue of rows.values()) {
    for (const ref of issue.externalRefs ?? []) {
      if (ref.provider !== binding.providerId || ref.meta?.binding !== binding.key) continue
      if (ref.remoteUpdatedAt !== undefined && (max === undefined || ref.remoteUpdatedAt > max)) {
        max = ref.remoteUpdatedAt
      }
    }
  }
  return max
}

async function upsertCycles(
  binding: IssueSyncBinding,
  cycles: readonly RemoteCycle[]
): Promise<Map<string, string>> {
  const byExternalId = new Map<string, string>()
  for (const remote of cycles) {
    const existing = await getIssueCycleByExternalKey(binding.providerId, remote.externalId)
    const ref: IssueExternalRef = {
      provider: binding.providerId,
      externalId: remote.externalId,
      ...(remote.url ? { url: remote.url } : {}),
      meta: { binding: binding.key },
    }
    if (existing) {
      await updateIssueCycle(existing.id, {
        name: remote.name,
        ...(remote.status ? { status: remote.status } : {}),
        startsAt: remote.startsAt ?? null,
        endsAt: remote.endsAt ?? null,
        externalRefs: [
          ...existing.externalRefs.filter((r) => externalKeyOf(r) !== externalKeyOf(ref)),
          ref,
        ],
      })
      byExternalId.set(remote.externalId, existing.id)
    } else {
      const created = await createIssueCycle({
        projectId: binding.projectId,
        issueProjectId: binding.issueProjectId,
        kind: remote.kind,
        name: remote.name,
        ...(remote.status ? { status: remote.status } : {}),
        ...(remote.startsAt !== undefined ? { startsAt: remote.startsAt } : {}),
        ...(remote.endsAt !== undefined ? { endsAt: remote.endsAt } : {}),
        externalRefs: [ref],
      })
      byExternalId.set(remote.externalId, created.id)
    }
  }
  return byExternalId
}

function refOf(
  issue: Issue,
  binding: IssueSyncBinding,
  externalId: string
): IssueExternalRef | undefined {
  return (issue.externalRefs ?? []).find(
    (ref) => ref.provider === binding.providerId && ref.externalId === externalId
  )
}

async function importRemote(
  binding: IssueSyncBinding,
  remote: RemoteIssue,
  cycleIdOf: (externalId: string) => string | undefined,
  now: number
): Promise<void> {
  const by = syncActorFor(binding.providerId)
  const labels = remote.labels?.length ? await ensureIssueLabels(remote.labels) : []
  const cycleId = remote.cycleExternalId ? cycleIdOf(remote.cycleExternalId) : undefined
  await createIssue({
    projectId: binding.projectId,
    issueProjectId: binding.issueProjectId,
    title: remote.title,
    ...(remote.description ? { description: remote.description } : {}),
    status: remote.status,
    ...(remote.priority ? { priority: remote.priority } : {}),
    ...(remote.assigneeLabel ? { assignee: { kind: "human", label: remote.assigneeLabel } } : {}),
    createdBy: by,
    labelIds: labels.map((row) => row.id),
    ...(typeof remote.dueDate === "number" ? { dueDate: remote.dueDate } : {}),
    ...(typeof remote.estimate === "number" ? { estimate: remote.estimate } : {}),
    ...(cycleId ? { cycleId } : {}),
    externalRefs: [
      {
        provider: binding.providerId,
        externalId: remote.externalId,
        ...(remote.url ? { url: remote.url } : {}),
        ...(remote.label ? { label: remote.label } : {}),
        syncedAt: now,
        remoteUpdatedAt: remote.remoteUpdatedAt,
        meta: { binding: binding.key, ...(remote.meta ?? {}) },
      },
    ],
  })
}

interface FieldContext {
  labelsById: Map<string, LabelRow>
  cycleExternalIdOf: (cycleId: string) => string | undefined
  cycleIdOf: (externalId: string) => string | undefined
}

async function buildFieldContext(binding: IssueSyncBinding): Promise<FieldContext> {
  const labels = await listLabels("issue")
  const cycles = await listIssueCycles({ projectId: binding.projectId })
  const externalByCycleId = new Map<string, string>()
  const cycleIdByExternal = new Map<string, string>()
  for (const cycle of cycles) {
    for (const ref of cycle.externalRefs) {
      if (ref.provider !== binding.providerId) continue
      externalByCycleId.set(cycle.id, ref.externalId)
      cycleIdByExternal.set(ref.externalId, cycle.id)
    }
  }
  return {
    labelsById: new Map(labels.map((row) => [row.id, row])),
    cycleExternalIdOf: (id) => externalByCycleId.get(id),
    cycleIdOf: (externalId) => cycleIdByExternal.get(externalId),
  }
}

/** Reload the row after writers touched it. */
async function fresh(issueId: string): Promise<Issue | undefined> {
  return getDb().issues.get(issueId)
}

async function reconcileItem(
  binding: IssueSyncBinding,
  provider: IssueSyncProvider,
  local: Issue,
  remote: RemoteIssue,
  context: FieldContext,
  now: number,
  tally: ReconcileOutcome
): Promise<{ patch: RemotePatch; pushFields: IssueSyncField[]; watermark: number }> {
  const by = syncActorFor(binding.providerId, provider.label)
  const ref = refOf(local, binding, remote.externalId)
  const syncedAt = ref?.syncedAt
  const firstTime = syncedAt === undefined
  const remoteChanged = firstTime || remote.remoteUpdatedAt > syncedAt
  const events = await listIssueEvents({ issueId: local.id })
  const localClock = lastLocalChangeAt(events, syncedAt ?? 0)
  // The trail's clock is monotonic and may run a millisecond ahead of the
  // wall clock, so an edit made just before this pass can carry a ts later
  // than `now`. The ref must be stamped no earlier than the newest event it
  // examined, or that edit looks new again next time and is pushed twice.
  const watermark = events.reduce((max, event) => Math.max(max, event.ts), now)
  const runActive = await hasActiveIssueRun(local.id)

  const patch: RemotePatch = {}
  const pushFields: IssueSyncField[] = []
  let touched = false

  for (const field of ISSUE_SYNC_FIELDS) {
    const remoteValue = remoteFieldValue(remote, field)
    if (remoteValue === undefined || !provider.pullFields.includes(field)) continue
    const current = (await fresh(local.id)) ?? local
    const localValue = localFieldValue(current, field, context)
    if (!fieldValuesDiffer(localValue, remoteValue)) continue
    if (
      field === "status" &&
      remote.coarseStatus &&
      typeof localValue === "string" &&
      typeof remoteValue === "string" &&
      coarseStatusBucket(localValue as IssueStatus) ===
        coarseStatusBucket(remoteValue as IssueStatus)
    ) {
      continue
    }

    const localChangedAt = localClock.get(field)
    const canPush = provider.pushFields.includes(field) && Boolean(provider.push)

    let winner: "local" | "remote"
    let conflict = false
    if (localChangedAt === undefined) {
      // Only the remote moved (or nothing did and this is the first pass).
      winner = "remote"
    } else if (!remoteChanged) {
      winner = "local"
    } else {
      conflict = true
      winner = remote.remoteUpdatedAt > localChangedAt ? "remote" : "local"
    }
    if (conflict) {
      await appendIssueEvent({
        issueId: local.id,
        payload: {
          kind: "sync_conflict",
          provider: binding.providerId,
          field,
          winner,
          localValue,
          remoteValue,
          by,
        },
      })
      tally.conflicts += 1
    }

    if (winner === "remote") {
      const applied = await applyRemoteField(current, field, remoteValue, by, {
        provider: binding.providerId,
        cycleIdOf: context.cycleIdOf,
        runActive,
      })
      if (applied) touched = true
    } else if (canPush) {
      pushFields.push(field)
      addToPatch(patch, field, localValue)
    }
  }

  // Fields the remote item did not carry (a provider that only reports what
  // it stores) but a person changed locally still go out.
  for (const [field] of localClock) {
    if (pushFields.includes(field)) continue
    if (remoteFieldValue(remote, field) !== undefined) continue
    if (!provider.pushFields.includes(field) || !provider.push) continue
    const current = (await fresh(local.id)) ?? local
    pushFields.push(field)
    addToPatch(patch, field, localFieldValue(current, field, context))
  }

  if (touched) tally.updated += 1
  return { patch, pushFields, watermark }
}

function addToPatch(patch: RemotePatch, field: IssueSyncField, value: RemoteFieldValue): void {
  switch (field) {
    case "title":
      if (typeof value === "string") patch.title = value
      break
    case "description":
      patch.description = typeof value === "string" ? value : null
      break
    case "status":
      if (typeof value === "string") patch.status = value as RemotePatch["status"]
      break
    case "priority":
      if (typeof value === "string") patch.priority = value as RemotePatch["priority"]
      break
    case "labels":
      patch.labels = Array.isArray(value) ? value : []
      break
    case "dueDate":
      patch.dueDate = typeof value === "number" ? value : null
      break
    case "estimate":
      patch.estimate = typeof value === "number" ? value : null
      break
    case "cycle":
      patch.cycleExternalId = typeof value === "string" ? value : null
      break
    case "assignee":
      break
  }
}

async function pushPatch(
  binding: IssueSyncBinding,
  provider: IssueSyncProvider,
  issue: Issue,
  ref: IssueExternalRef,
  patch: RemotePatch,
  syncedAt: number,
  tally: ReconcileOutcome
): Promise<void> {
  if (!provider.push || Object.keys(patch).length === 0) return
  const by = syncActorFor(binding.providerId, provider.label)
  const outcome = await provider.push(binding, ref, patch, issue, {
    idempotencyKey: pushIdempotencyKey(issue.id, patch),
    by,
  })
  if (outcome.status === "queued") {
    tally.queued += 1
    return
  }
  tally.pushed += 1
  await touchIssueExternalRef(issue.id, ref, {
    syncedAt,
    ...(outcome.remoteUpdatedAt !== undefined
      ? { remoteUpdatedAt: outcome.remoteUpdatedAt }
      : ref.remoteUpdatedAt !== undefined
        ? { remoteUpdatedAt: ref.remoteUpdatedAt }
        : {}),
    meta: { ...(ref.meta ?? {}), binding: binding.key },
  })
}

async function linkRemote(
  binding: IssueSyncBinding,
  links: readonly RemoteLink[],
  tally: ReconcileOutcome
): Promise<void> {
  if (links.length === 0) return
  const db = getDb()
  const byIdentifier = new Map<string, Issue>()
  for (const issue of await db.issues.where("projectId").equals(binding.projectId).toArray()) {
    byIdentifier.set(issue.identifier.toUpperCase(), issue)
  }
  const by = syncActorFor(binding.providerId)
  for (const link of links) {
    const targets = new Map<string, Issue>()
    for (const identifier of link.mentionsIdentifiers) {
      const issue = byIdentifier.get(identifier.toUpperCase())
      if (issue) targets.set(issue.id, issue)
    }
    for (const externalId of link.mentionsExternalIds) {
      const issue = await getIssueByExternalKey(binding.providerId, externalId)
      if (issue) targets.set(issue.id, issue)
    }
    for (const issue of targets.values()) {
      const already = (issue.externalKeys ?? []).includes(
        externalKeyOf({ provider: link.provider, externalId: link.externalId })
      )
      if (already) continue
      await linkIssueExternal(
        issue.id,
        {
          provider: link.provider,
          externalId: link.externalId,
          ...(link.url ? { url: link.url } : {}),
          ...(link.label ? { label: link.label } : {}),
          meta: { binding: binding.key },
        },
        by
      )
      tally.linked += 1
    }
  }
}

export async function reconcileBinding(
  binding: IssueSyncBinding,
  provider: IssueSyncProvider,
  options: ReconcileOptions = {}
): Promise<ReconcileOutcome> {
  const now = options.now ?? Date.now
  const tally: ReconcileOutcome = {
    binding,
    created: 0,
    updated: 0,
    pushed: 0,
    queued: 0,
    conflicts: 0,
    linked: 0,
    cycles: 0,
    notModified: false,
    truncated: false,
  }

  const since = options.full ? undefined : await bindingWatermark(binding)
  const pulled = await provider.pull(binding, {
    ...(since !== undefined ? { since } : {}),
    ...(options.full ? { full: true } : {}),
  })
  tally.notModified = pulled.notModified
  tally.truncated = pulled.truncated ?? false

  if (pulled.cycles?.length) {
    await upsertCycles(binding, pulled.cycles)
    tally.cycles = pulled.cycles.length
  }
  const context = await buildFieldContext(binding)

  const pending = new Map<
    string,
    { issue: Issue; ref: IssueExternalRef; patch: RemotePatch; syncedAt: number }
  >()
  const stamp = now()

  for (const remote of pulled.items) {
    const local = await getIssueByExternalKey(binding.providerId, remote.externalId)
    if (!local) {
      await importRemote(binding, remote, context.cycleIdOf, stamp)
      tally.created += 1
      continue
    }
    if (local.projectId !== binding.projectId) continue
    const { patch, watermark } = await reconcileItem(
      binding,
      provider,
      local,
      remote,
      context,
      stamp,
      tally
    )
    const current = (await fresh(local.id)) ?? local
    const ref = refOf(current, binding, remote.externalId)
    if (!ref) continue
    if (Object.keys(patch).length > 0) {
      pending.set(current.id, { issue: current, ref, patch, syncedAt: watermark })
    } else {
      await touchIssueExternalRef(current.id, ref, {
        syncedAt: watermark,
        remoteUpdatedAt: remote.remoteUpdatedAt,
        meta: { ...(ref.meta ?? {}), binding: binding.key, ...(remote.meta ?? {}) },
      })
    }
  }

  // Local edits on rows the pull did not mention (incremental pulls only
  // carry what changed remotely) still need to go out.
  if (provider.push && provider.pushFields.length > 0) {
    const linked = await mapIssuesByExternalProvider(binding.providerId, binding.projectId)
    for (const [externalId, issue] of linked) {
      if (pending.has(issue.id)) continue
      const ref = refOf(issue, binding, externalId)
      if (!ref || ref.meta?.binding !== binding.key || ref.syncedAt === undefined) continue
      const events = await listIssueEvents({ issueId: issue.id })
      const clock = lastLocalChangeAt(events, ref.syncedAt)
      if (clock.size === 0) continue
      const patch: RemotePatch = {}
      for (const field of clock.keys()) {
        if (!provider.pushFields.includes(field)) continue
        addToPatch(patch, field, localFieldValue(issue, field, context))
      }
      const watermark = events.reduce((max, event) => Math.max(max, event.ts), stamp)
      if (Object.keys(patch).length > 0) {
        pending.set(issue.id, { issue, ref, patch, syncedAt: watermark })
      }
    }
  }

  for (const { issue, ref, patch, syncedAt } of pending.values()) {
    await pushPatch(binding, provider, issue, ref, patch, syncedAt, tally)
  }

  if (pulled.links?.length) await linkRemote(binding, pulled.links, tally)

  return tally
}
