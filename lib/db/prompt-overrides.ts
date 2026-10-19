/**
 * Persistence for code-owned prompt overrides (ADR-0236).
 *
 * Only prompts with no editable owner of their own live here: a feature
 * template's text is a constant in code, so a user's version of it needs a
 * store. Characters, presets, Skills and project instruction files keep their
 * existing records and are never mirrored into these tables.
 *
 * Two tables:
 *
 * - `promptOverrides`: one binding per (prompt, scope, target). It points at
 *   the active published revision (`null` means "inherit", either never
 *   published or reset), at an optional draft, and carries a concurrency
 *   counter `rev` every mutation must name.
 * - `promptOverrideRevisions`: immutable revision records. Publishing writes a
 *   new revision and moves the pointer in one transaction; reset writes a
 *   `reset` revision and clears the pointer; restore republishes an old body
 *   as a new revision. Nothing is edited in place.
 *
 * Revisions hold static user-authored text only, never rendered prompts with
 * live task data. The tables are account-scoped content (encrypted at rest by
 * the account content middleware) and are not account-synced.
 */

import { getDb } from "./schema"
import type { PromptScope, PromptTargetRef } from "@/lib/prompts/types"

export interface PromptOverrideBindingRow {
  /** `pob_…` */
  id: string
  promptId: string
  scope: PromptScope
  /** Workspace / agent / session id; empty for the account scope. */
  targetId: string
  /** The published revision consumers resolve, or `null` to inherit. */
  activeRevisionId: string | null
  /** Unpublished work in progress, or `null`. */
  draftRevisionId: string | null
  /** Concurrency counter; every mutation must name the value it read. */
  rev: number
  createdAt: number
  updatedAt: number
}

export type PromptRevisionKind = "draft" | "published" | "reset"
export type PromptRevisionOrigin = "editor" | "import" | "restore" | "cli"

export interface PromptOverrideRevisionRow {
  /** `por_…` */
  id: string
  bindingId: string
  promptId: string
  /** The active revision this one was written over, for history. */
  parentId: string | null
  kind: PromptRevisionKind
  /** Static template text. Empty for a `reset` revision. */
  body: string
  /** The definition contract the body was validated against. */
  contractVersion: number
  /** Digest of the shipped default the edit was made against (upgrade compare). */
  baseDigest: string
  origin: PromptRevisionOrigin
  /** Caller-supplied idempotency key; a replay returns the settled binding. */
  mutationId: string
  createdAt: number
}

/** Inactive published/reset revisions kept per binding, beyond active and draft. */
export const PROMPT_REVISION_HISTORY_LIMIT = 50

export class PromptOverrideConflictError extends Error {
  readonly code = "prompt_override_conflict"
  constructor(
    readonly expectedRev: number,
    readonly currentRev: number
  ) {
    super(`prompt override changed (expected rev ${expectedRev}, found ${currentRev})`)
    this.name = "PromptOverrideConflictError"
  }
}

export function isPromptOverrideConflict(error: unknown): error is PromptOverrideConflictError {
  return error instanceof PromptOverrideConflictError
}

type Listener = () => void
const listeners = new Set<Listener>()

/** Subscribe to committed mutations in this context (the snapshot cache listens). */
export function onPromptOverridesChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A listener failure must not turn a committed write into an error.
    }
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeTarget(target: PromptTargetRef): PromptTargetRef {
  return target.scope === "account"
    ? { scope: "account", targetId: "" }
    : { scope: target.scope, targetId: target.targetId }
}

export async function listPromptOverrideBindings(): Promise<PromptOverrideBindingRow[]> {
  return getDb().promptOverrides.toArray()
}

export async function listPromptOverrideBindingsFor(
  promptId: string
): Promise<PromptOverrideBindingRow[]> {
  return getDb().promptOverrides.where("promptId").equals(promptId).toArray()
}

export async function getPromptOverrideBinding(
  promptId: string,
  target: PromptTargetRef
): Promise<PromptOverrideBindingRow | undefined> {
  const { scope, targetId } = normalizeTarget(target)
  return getDb()
    .promptOverrides.where("[promptId+scope+targetId]")
    .equals([promptId, scope, targetId])
    .first()
}

export async function getPromptOverrideRevision(
  id: string
): Promise<PromptOverrideRevisionRow | undefined> {
  return getDb().promptOverrideRevisions.get(id)
}

/** Every revision of a binding, newest first. */
export async function listPromptOverrideRevisions(
  bindingId: string
): Promise<PromptOverrideRevisionRow[]> {
  const rows = await getDb().promptOverrideRevisions.where("bindingId").equals(bindingId).toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

/** Revisions by id, for building the resolver snapshot in one read. */
export async function getPromptOverrideRevisions(
  ids: readonly string[]
): Promise<Array<PromptOverrideRevisionRow | undefined>> {
  return getDb().promptOverrideRevisions.bulkGet([...ids])
}

interface MutationBase {
  promptId: string
  target: PromptTargetRef
  /** The binding `rev` the caller read; 0 when no binding exists yet. */
  expectedRev: number
  mutationId: string
  origin: PromptRevisionOrigin
  now?: number
}

export interface WriteBodyInput extends MutationBase {
  body: string
  contractVersion: number
  baseDigest: string
}

async function runMutation(
  input: MutationBase,
  apply: (
    binding: PromptOverrideBindingRow,
    now: number
  ) => Promise<{ binding: PromptOverrideBindingRow; revision?: PromptOverrideRevisionRow }>
): Promise<PromptOverrideBindingRow> {
  const db = getDb()
  const { scope, targetId } = normalizeTarget(input.target)
  const now = input.now ?? Date.now()
  const result = await db.transaction(
    "rw",
    db.promptOverrides,
    db.promptOverrideRevisions,
    async () => {
      const existing = await db.promptOverrides
        .where("[promptId+scope+targetId]")
        .equals([input.promptId, scope, targetId])
        .first()
      if (existing) {
        const replay = await db.promptOverrideRevisions
          .where("bindingId")
          .equals(existing.id)
          .filter((row) => row.mutationId === input.mutationId)
          .first()
        if (replay) return { binding: existing, changed: false }
      }
      const currentRev = existing?.rev ?? 0
      if (currentRev !== input.expectedRev) {
        throw new PromptOverrideConflictError(input.expectedRev, currentRev)
      }
      const binding: PromptOverrideBindingRow = existing ?? {
        id: newId("pob"),
        promptId: input.promptId,
        scope,
        targetId,
        activeRevisionId: null,
        draftRevisionId: null,
        rev: 0,
        createdAt: now,
        updatedAt: now,
      }
      const applied = await apply(binding, now)
      const next: PromptOverrideBindingRow = {
        ...applied.binding,
        rev: currentRev + 1,
        updatedAt: now,
      }
      if (applied.revision) await db.promptOverrideRevisions.put(applied.revision)
      await db.promptOverrides.put(next)
      await pruneRevisions(next)
      return { binding: next, changed: true }
    }
  )
  if (result.changed) notify()
  return result.binding
}

/** Drop superseded drafts and inactive history beyond the limit. */
async function pruneRevisions(binding: PromptOverrideBindingRow): Promise<void> {
  const db = getDb()
  const rows = await db.promptOverrideRevisions.where("bindingId").equals(binding.id).toArray()
  const keep = new Set([binding.activeRevisionId, binding.draftRevisionId].filter(Boolean))
  const stale = rows.filter((row) => row.kind === "draft" && !keep.has(row.id)).map((row) => row.id)
  const history = rows
    .filter((row) => row.kind !== "draft" && !keep.has(row.id))
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  for (const row of history.slice(PROMPT_REVISION_HISTORY_LIMIT)) stale.push(row.id)
  if (stale.length > 0) await db.promptOverrideRevisions.bulkDelete(stale)
}

function revision(
  binding: PromptOverrideBindingRow,
  input: MutationBase,
  now: number,
  fields: Pick<PromptOverrideRevisionRow, "kind" | "body" | "contractVersion" | "baseDigest">
): PromptOverrideRevisionRow {
  return {
    id: newId("por"),
    bindingId: binding.id,
    promptId: binding.promptId,
    parentId: binding.activeRevisionId,
    origin: input.origin,
    mutationId: input.mutationId,
    createdAt: now,
    ...fields,
  }
}

/** Save unpublished work. Replaces the previous draft; consumers are unaffected. */
export async function savePromptOverrideDraft(
  input: WriteBodyInput
): Promise<PromptOverrideBindingRow> {
  return runMutation(input, async (binding, now) => {
    const draft = revision(binding, input, now, {
      kind: "draft",
      body: input.body,
      contractVersion: input.contractVersion,
      baseDigest: input.baseDigest,
    })
    return { binding: { ...binding, draftRevisionId: draft.id }, revision: draft }
  })
}

/**
 * Publish a body: a new immutable revision becomes active and any draft is
 * consumed, atomically. The caller validates the body against the definition
 * first (`lib/prompts/service.ts`); this layer only enforces concurrency.
 */
export async function publishPromptOverride(
  input: WriteBodyInput
): Promise<PromptOverrideBindingRow> {
  return runMutation(input, async (binding, now) => {
    const published = revision(binding, input, now, {
      kind: "published",
      body: input.body,
      contractVersion: input.contractVersion,
      baseDigest: input.baseDigest,
    })
    return {
      binding: { ...binding, activeRevisionId: published.id, draftRevisionId: null },
      revision: published,
    }
  })
}

/** Return the slot to inheritance. History is kept; the draft is discarded. */
export async function resetPromptOverride(
  input: MutationBase & { contractVersion: number; baseDigest: string }
): Promise<PromptOverrideBindingRow> {
  return runMutation(input, async (binding, now) => {
    const reset = revision(binding, input, now, {
      kind: "reset",
      body: "",
      contractVersion: input.contractVersion,
      baseDigest: input.baseDigest,
    })
    return {
      binding: { ...binding, activeRevisionId: null, draftRevisionId: null },
      revision: reset,
    }
  })
}

/** Throw away the draft without touching the published revision. */
export async function discardPromptOverrideDraft(
  input: MutationBase
): Promise<PromptOverrideBindingRow> {
  return runMutation(input, async (binding) => ({
    binding: { ...binding, draftRevisionId: null },
  }))
}

/**
 * Remove a binding and all its revisions. For orphaned entries (an unknown or
 * uninstalled prompt id) and account cleanup; ordinary "go back to default"
 * is `resetPromptOverride`, which keeps history.
 */
export async function deletePromptOverrideBinding(
  bindingId: string,
  expectedRev: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.promptOverrides, db.promptOverrideRevisions, async () => {
    const binding = await db.promptOverrides.get(bindingId)
    if (!binding) return
    if (binding.rev !== expectedRev) {
      throw new PromptOverrideConflictError(expectedRev, binding.rev)
    }
    await db.promptOverrideRevisions.where("bindingId").equals(bindingId).delete()
    await db.promptOverrides.delete(bindingId)
  })
  notify()
}
