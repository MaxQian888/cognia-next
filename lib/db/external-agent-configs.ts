/**
 * Host-owned external-agent configurations: head + append-only revisions.
 *
 * See `types/agent/external-agent-config-store.ts` for why the shape is a head
 * pointing at immutable revisions rather than a single mutable row.
 *
 * Everything that mutates runs inside one Dexie transaction over both tables.
 * A revision appended without its head moving is an orphan; a head moved to a
 * revision that was not written is a dangling pointer that resolves to nothing
 * and takes the configuration offline. Neither is recoverable by a retry, so
 * neither is allowed to happen halfway.
 *
 * This module does NOT decide readiness. `lifecycleStatus` arrives on the
 * config, computed by `lib/ai/agent/external/lifecycle/service.ts`, which owns
 * credential/runtime/consent reconciliation. Recomputing it here would be a
 * second opinion on a question that already has an owner.
 */

import type { StoredExternalAgentConfig } from "@/stores/agent/external-agent-store/types"
import type {
  ExternalAgentConfigAdmission,
  ExternalAgentConfigHeadRow,
  ExternalAgentConfigId,
  ExternalAgentConfigRecord,
  ExternalAgentConfigRevisionRow,
  ExternalAgentConfigStamp,
} from "@/types/agent/external-agent-config-store"

import { getDb } from "./schema"

/** Thrown when a compare-and-swap loses. Carries the winner so callers can merge. */
export class ExternalAgentConfigConflictError extends Error {
  readonly code = "external_agent_config_conflict"

  constructor(
    readonly current: ExternalAgentConfigRecord,
    readonly expectedRevision: string
  ) {
    super(
      `external agent config ${current.configId} moved to revision ${current.revision} (expected ${expectedRevision})`
    )
    this.name = "ExternalAgentConfigConflictError"
  }
}

export class ExternalAgentConfigNotFoundError extends Error {
  readonly code = "external_agent_config_not_found"

  constructor(readonly configId: string) {
    super(`external agent config ${configId} does not exist on this host`)
    this.name = "ExternalAgentConfigNotFoundError"
  }
}

/**
 * How long a superseded, unleased revision is kept.
 *
 * Not zero: a run admitted a moment before an edit still has to resolve its
 * revision, and a lease is taken at admission rather than at request time, so
 * there is a real window in which an unleased revision is still needed.
 */
export const REVISION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function randomId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}_${random.replace(/-/g, "")}`
}

/** Ids are minted here so they are never chosen by a caller and never reused. */
export const newExternalAgentConfigId = (): ExternalAgentConfigId => randomId("eac")
const newRevisionId = () => randomId("eacr")

function toRecord(
  head: ExternalAgentConfigHeadRow,
  revision: ExternalAgentConfigRevisionRow
): ExternalAgentConfigRecord {
  return {
    configId: head.configId,
    revision: head.revision,
    lifecycleGeneration: head.lifecycleGeneration,
    seq: revision.seq,
    config: revision.config,
    // Projected from the resolved config rather than stored twice — one source
    // of truth for "is this runnable", which is the whole point of the join.
    enabled: revision.config.enabled === true,
    lifecycleStatus: revision.config.lifecycleStatus ?? "ready",
    tombstonedAt: head.tombstonedAt,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
  }
}

/**
 * Does this edit change whether the agent can run, as opposed to what it says?
 *
 * Only these two move `lifecycleGeneration`. A rename or a timeout tweak must
 * not invalidate an in-flight admission — the run already holds the revision
 * it was admitted against, and nothing about its ability to run has changed.
 */
function readinessChanged(
  before: StoredExternalAgentConfig,
  after: StoredExternalAgentConfig
): boolean {
  return (
    before.enabled !== after.enabled ||
    (before.lifecycleStatus ?? "ready") !== (after.lifecycleStatus ?? "ready")
  )
}

async function resolve(
  configId: string
): Promise<{ head: ExternalAgentConfigHeadRow; revision: ExternalAgentConfigRevisionRow } | null> {
  const db = getDb()
  const head = await db.externalAgentConfigHeads.get(configId)
  if (!head) return null
  const revision = await db.externalAgentConfigRevisions.get(head.revision)
  // A head whose revision is gone is a corrupt store, not an empty one. Report
  // it as absent rather than resurrecting a different revision, which would
  // silently run a configuration the user never approved.
  if (!revision) return null
  return { head, revision }
}

/** One configuration, or `null` when it is absent. Tombstoned rows ARE returned. */
export async function getExternalAgentConfig(
  configId: string
): Promise<ExternalAgentConfigRecord | null> {
  const resolved = await resolve(configId)
  return resolved ? toRecord(resolved.head, resolved.revision) : null
}

/**
 * Every configuration on this host, newest first.
 *
 * Tombstoned rows are excluded by default: a deleted configuration is not
 * something a picker should offer. `includeDeleted` exists for reconciliation,
 * which has to see them to know a lease points at something gone.
 */
export async function listExternalAgentConfigs(
  options: { includeDeleted?: boolean } = {}
): Promise<ExternalAgentConfigRecord[]> {
  const db = getDb()
  const heads = await db.externalAgentConfigHeads.toArray()
  const live = options.includeDeleted ? heads : heads.filter((h) => h.tombstonedAt === undefined)
  if (live.length === 0) return []

  const revisions = await db.externalAgentConfigRevisions.bulkGet(live.map((h) => h.revision))
  const records: ExternalAgentConfigRecord[] = []
  for (const [index, head] of live.entries()) {
    const revision = revisions[index]
    if (revision) records.push(toRecord(head, revision))
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface CreateExternalAgentConfigInput {
  config: StoredExternalAgentConfig
  now?: number
}

/**
 * Write a new configuration and its first revision.
 *
 * The caller's `config.id` is overwritten with the generated id on purpose:
 * an id supplied by a browser is an id an attacker can choose, and a chosen id
 * could collide with a tombstone and inherit its leases.
 */
export async function createExternalAgentConfig(
  input: CreateExternalAgentConfigInput
): Promise<ExternalAgentConfigRecord> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const configId = newExternalAgentConfigId()
  const revisionId = newRevisionId()
  const config: StoredExternalAgentConfig = { ...input.config, id: configId }

  const head: ExternalAgentConfigHeadRow = {
    configId,
    revision: revisionId,
    lifecycleGeneration: 1,
    createdAt: now,
    updatedAt: now,
  }
  const revision: ExternalAgentConfigRevisionRow = {
    revisionId,
    configId,
    seq: 1,
    config,
    createdAt: now,
    leaseRuns: [],
  }

  await db.transaction(
    "rw",
    db.externalAgentConfigHeads,
    db.externalAgentConfigRevisions,
    async () => {
      await db.externalAgentConfigRevisions.add(revision)
      await db.externalAgentConfigHeads.add(head)
    }
  )
  return toRecord(head, revision)
}

export interface UpdateExternalAgentConfigInput {
  configId: string
  /** The revision the caller believes is current. The CAS check. */
  expectedRevision: string
  /** Produces the next config from the current one. Must be pure. */
  mutate: (current: StoredExternalAgentConfig) => StoredExternalAgentConfig
  now?: number
}

/**
 * Append a revision and move the head, or refuse.
 *
 * `mutate` runs INSIDE the transaction against the row that was actually read,
 * so a caller cannot compute its next state from a config that changed between
 * its read and its write. The CAS check is what turns a lost update into a
 * reported conflict.
 */
export async function updateExternalAgentConfig(
  input: UpdateExternalAgentConfigInput
): Promise<ExternalAgentConfigRecord> {
  const db = getDb()
  const now = input.now ?? Date.now()

  return db.transaction(
    "rw",
    db.externalAgentConfigHeads,
    db.externalAgentConfigRevisions,
    async () => {
      const head = await db.externalAgentConfigHeads.get(input.configId)
      if (!head) throw new ExternalAgentConfigNotFoundError(input.configId)
      const currentRevision = await db.externalAgentConfigRevisions.get(head.revision)
      if (!currentRevision) throw new ExternalAgentConfigNotFoundError(input.configId)

      const current = toRecord(head, currentRevision)
      if (head.tombstonedAt !== undefined) {
        // Editing a deleted configuration would resurrect it under an id that
        // other rows may already treat as gone.
        throw new ExternalAgentConfigNotFoundError(input.configId)
      }
      if (head.revision !== input.expectedRevision) {
        throw new ExternalAgentConfigConflictError(current, input.expectedRevision)
      }

      const nextConfig: StoredExternalAgentConfig = {
        ...input.mutate(currentRevision.config),
        // The id is the store's, not the caller's — a mutate that rewrote it
        // would strand the head.
        id: input.configId,
      }
      const revisionId = newRevisionId()
      const revision: ExternalAgentConfigRevisionRow = {
        revisionId,
        configId: input.configId,
        seq: currentRevision.seq + 1,
        config: nextConfig,
        createdAt: now,
        leaseRuns: [],
      }
      const nextHead: ExternalAgentConfigHeadRow = {
        ...head,
        revision: revisionId,
        lifecycleGeneration:
          head.lifecycleGeneration + (readinessChanged(currentRevision.config, nextConfig) ? 1 : 0),
        updatedAt: now,
      }

      await db.externalAgentConfigRevisions.add(revision)
      await db.externalAgentConfigHeads.put(nextHead)
      return toRecord(nextHead, revision)
    }
  )
}

/**
 * Tombstone a configuration.
 *
 * The head stays so that leases, audit and any admission still in flight
 * resolve to "this was deleted" rather than to nothing — which is what lets a
 * queued turn be refused with a reason instead of a null dereference. The
 * generation moves because readiness certainly changed.
 */
export async function deleteExternalAgentConfig(
  configId: string,
  now: number = Date.now()
): Promise<ExternalAgentConfigRecord> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.externalAgentConfigHeads,
    db.externalAgentConfigRevisions,
    async () => {
      const head = await db.externalAgentConfigHeads.get(configId)
      if (!head) throw new ExternalAgentConfigNotFoundError(configId)
      const revision = await db.externalAgentConfigRevisions.get(head.revision)
      if (!revision) throw new ExternalAgentConfigNotFoundError(configId)
      if (head.tombstonedAt !== undefined) return toRecord(head, revision)

      const nextHead: ExternalAgentConfigHeadRow = {
        ...head,
        tombstonedAt: now,
        lifecycleGeneration: head.lifecycleGeneration + 1,
        updatedAt: now,
      }
      await db.externalAgentConfigHeads.put(nextHead)
      return toRecord(nextHead, revision)
    }
  )
}

/**
 * Can this run start against the configuration it named?
 *
 * Every refusal is a distinct reason because they need distinct handling: a
 * stale revision is a retry after a re-read, a disabled config is a user
 * action, and a tombstone is neither.
 */
export async function admitExternalAgentConfig(
  stamp: ExternalAgentConfigStamp
): Promise<ExternalAgentConfigAdmission> {
  const resolved = await resolve(stamp.configId)
  if (!resolved) return { ok: false, reason: "unknown-config" }

  const record = toRecord(resolved.head, resolved.revision)
  if (record.tombstonedAt !== undefined) return { ok: false, reason: "deleted", current: record }
  if (record.revision !== stamp.revision)
    return { ok: false, reason: "stale-revision", current: record }
  if (record.lifecycleGeneration !== stamp.lifecycleGeneration)
    return { ok: false, reason: "stale-generation", current: record }
  if (!record.enabled) return { ok: false, reason: "disabled", current: record }
  if (record.lifecycleStatus !== "ready") return { ok: false, reason: "not-ready", current: record }
  return { ok: true, record }
}

/**
 * Pin a revision for the lifetime of a run.
 *
 * Taken at admission, not at request time: a lease handed out before the
 * admission check would keep alive revisions for runs that were then refused.
 */
export async function leaseExternalAgentConfigRevision(
  revisionId: string,
  runId: string
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.externalAgentConfigRevisions, async () => {
    const revision = await db.externalAgentConfigRevisions.get(revisionId)
    if (!revision || revision.leaseRuns.includes(runId)) return
    await db.externalAgentConfigRevisions.put({
      ...revision,
      leaseRuns: [...revision.leaseRuns, runId],
    })
  })
}

/** Release every revision this run pinned. Safe to call for an unknown run. */
export async function releaseExternalAgentConfigLeases(runId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.externalAgentConfigRevisions, async () => {
    const held = await db.externalAgentConfigRevisions.where("leaseRuns").equals(runId).toArray()
    for (const revision of held) {
      await db.externalAgentConfigRevisions.put({
        ...revision,
        leaseRuns: revision.leaseRuns.filter((id) => id !== runId),
      })
    }
  })
}

/**
 * Drop superseded revisions that nothing references and that are past
 * retention. Returns how many were removed.
 *
 * Head revisions are never collected regardless of age — they are the
 * configuration. A leased revision is never collected regardless of age — a
 * run is still using it.
 */
export async function collectExternalAgentConfigRevisions(
  now: number = Date.now(),
  retentionMs: number = REVISION_RETENTION_MS
): Promise<number> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.externalAgentConfigHeads,
    db.externalAgentConfigRevisions,
    async () => {
      const heads = await db.externalAgentConfigHeads.toArray()
      const pinnedByHead = new Set(heads.map((h) => h.revision))
      const all = await db.externalAgentConfigRevisions.toArray()
      const collectable = all.filter(
        (r) =>
          !pinnedByHead.has(r.revisionId) &&
          r.leaseRuns.length === 0 &&
          now - r.createdAt >= retentionMs
      )
      if (collectable.length === 0) return 0
      await db.externalAgentConfigRevisions.bulkDelete(collectable.map((r) => r.revisionId))
      return collectable.length
    }
  )
}

/** The revision history of one configuration, oldest first. */
export async function listExternalAgentConfigRevisions(
  configId: string
): Promise<ExternalAgentConfigRevisionRow[]> {
  return getDb()
    .externalAgentConfigRevisions.where("[configId+seq]")
    .between([configId, 0], [configId, Infinity])
    .toArray()
}
