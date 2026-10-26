/**
 * The in-memory view of published prompt overrides the resolver reads.
 *
 * Consumers resolve synchronously (a subagent definition is projected inside
 * a sync function; a title template is read once per call), so the resolver
 * never queries Dexie itself. One snapshot of every active binding is loaded
 * per account database and replaced whenever a mutation commits, here or in
 * another window (the initializer subscribes to a live query for that).
 *
 * A snapshot is tied to the database it was read from: after an account
 * switch `peekPromptOverrideSnapshot()` reports nothing until the new account's
 * overrides are loaded, so one account's text can never apply to another.
 */

import { getDb } from "@/lib/db/schema"
import {
  getPromptOverrideRevisions,
  listPromptOverrideBindings,
  onPromptOverridesChanged,
} from "@/lib/db/prompt-overrides"
import type { PromptScope } from "./types"

export interface ActivePromptOverride {
  bindingId: string
  promptId: string
  scope: PromptScope
  targetId: string
  revisionId: string
  body: string
  contractVersion: number
}

export interface PromptOverrideSnapshot {
  /** Name of the account database the snapshot was read from. */
  databaseName: string
  byPrompt: ReadonlyMap<string, readonly ActivePromptOverride[]>
  loadedAt: number
}

let current: PromptOverrideSnapshot | null = null
let inflight: Promise<PromptOverrideSnapshot> | null = null
/** Bumped by every invalidation, so a load that started earlier cannot win. */
let generation = 0
const subscribers = new Set<() => void>()
let unsubscribeWrites: (() => void) | null = null
/** Test seam: the database name to treat as active when no Dexie exists. */
let testDatabaseName: string | null = null

function activeDatabaseName(): string | null {
  if (testDatabaseName !== null) return testDatabaseName
  try {
    return getDb().name
  } catch {
    return null
  }
}

/** Build a snapshot from bindings and their active revisions. Pure; exported for tests. */
export function buildPromptOverrideSnapshot(
  databaseName: string,
  rows: readonly ActivePromptOverride[],
  loadedAt = Date.now()
): PromptOverrideSnapshot {
  const byPrompt = new Map<string, ActivePromptOverride[]>()
  for (const row of rows) {
    const list = byPrompt.get(row.promptId) ?? []
    list.push(row)
    byPrompt.set(row.promptId, list)
  }
  return { databaseName, byPrompt, loadedAt }
}

async function readSnapshot(): Promise<PromptOverrideSnapshot> {
  const databaseName = getDb().name
  const bindings = (await listPromptOverrideBindings()).filter((row) => row.activeRevisionId)
  const revisions = await getPromptOverrideRevisions(bindings.map((row) => row.activeRevisionId!))
  const rows: ActivePromptOverride[] = []
  bindings.forEach((binding, index) => {
    const revision = revisions[index]
    // A pointer at a missing or non-published revision is skipped rather than
    // resolved to an empty body: an absent override means the shipped text.
    if (!revision || revision.kind !== "published") return
    rows.push({
      bindingId: binding.id,
      promptId: binding.promptId,
      scope: binding.scope,
      targetId: binding.targetId,
      revisionId: revision.id,
      body: revision.body,
      contractVersion: revision.contractVersion,
    })
  })
  return buildPromptOverrideSnapshot(databaseName, rows)
}

function ensureWriteSubscription(): void {
  if (unsubscribeWrites) return
  unsubscribeWrites = onPromptOverridesChanged(() => {
    invalidatePromptOverrideSnapshot()
    void loadPromptOverrideSnapshot().catch(() => undefined)
  })
}

/**
 * The current snapshot for the active account, or `null` when none is loaded
 * (first use, account switch, or a context without a database).
 */
export function peekPromptOverrideSnapshot(): PromptOverrideSnapshot | null {
  if (!current) return null
  return current.databaseName === activeDatabaseName() ? current : null
}

/** Load (or reuse an in-flight load of) the active account's snapshot. */
export async function loadPromptOverrideSnapshot(): Promise<PromptOverrideSnapshot> {
  ensureWriteSubscription()
  const fresh = peekPromptOverrideSnapshot()
  if (fresh && !inflight) return fresh
  if (inflight) return inflight
  const started = generation
  const load = readSnapshot()
    .then((snapshot) => {
      if (started === generation) {
        current = snapshot
        for (const subscriber of subscribers) subscriber()
      }
      return snapshot
    })
    .finally(() => {
      if (inflight === load) inflight = null
    })
  inflight = load
  return load
}

/** Drop the cached snapshot; the next load reads the database again. */
export function invalidatePromptOverrideSnapshot(): void {
  generation += 1
  current = null
  inflight = null
}

/** Called after a snapshot is replaced. Returns an unsubscribe function. */
export function subscribePromptOverrideSnapshot(listener: () => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

/** Test seam: install a snapshot without a database (and treat its db as active). */
export function __setPromptOverrideSnapshotForTests(snapshot: PromptOverrideSnapshot | null): void {
  generation += 1
  current = snapshot
  inflight = null
  testDatabaseName = snapshot?.databaseName ?? null
}
