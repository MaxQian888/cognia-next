/**
 * Materialization worker — turns accepted inbound drafts into live objects
 * (ADR-0008 Phase 4).
 *
 * Drains the `inboundMaterializations` outbox that `acceptInboundDraft` fills.
 * One draft kind → one target:
 *
 *   • `lesson` → a semantic memory with `external` provenance
 *   • `skill`  → a real Skill, created `disabled`
 *   • `note`   → a `knowledgeNotes` row
 *
 * ## Why a skill lands disabled
 *
 * A Skill is an instruction set the assistant will follow. Materializing one
 * straight to `enabled` would let an external agent write the assistant's
 * working instructions by getting a single draft accepted — accepting a draft
 * means "this is worth keeping", not "this may now act on my behalf". Enabling
 * it is a separate, explicit decision by the user.
 *
 * ## Why the worker is idempotent per draft
 *
 * The outbox is keyed by draft id and every handler probes for its own prior
 * output before creating anything, so a job re-run after a crash — or a retry
 * of a job that failed *after* writing — converges instead of duplicating. The
 * outbox row's `producedId` is the authority once set.
 *
 * ## Why acceptance is never reversed on failure
 *
 * Materialization can fail (a disabled memory subsystem, a provider outage).
 * The review decision stays `accepted` and the job retries underneath it.
 * Un-accepting would mean revoking a decision the operator already made,
 * possibly after some of its effects already landed.
 */

import { getInboundDraft, materializableBody, type InboundDraftRow } from "@/lib/db/inbound-drafts"
import {
  getInboundMaterialization,
  listQueuedMaterializations,
  markMaterializationCompleted,
  markMaterializationFailed,
  markMaterializationRunning,
  type InboundMaterializationRow,
} from "@/lib/db/inbound-materializations"
import { addKnowledgeNote, findKnowledgeNoteBySourceDraft } from "@/lib/db/knowledge-notes"
import { stripUntrustedEnvelope } from "./canonical-hash"

export interface MaterializeResult {
  draftId: string
  status: "completed" | "failed" | "skipped"
  producedId?: string
  error?: string
}

/**
 * Drain up to `limit` queued jobs.
 *
 * Never throws: a job that fails is recorded as `failed` on its own row and the
 * drain continues. One poisonous draft must not stall the queue behind it.
 */
export async function runMaterializationPass(limit = 20): Promise<MaterializeResult[]> {
  const jobs = await listQueuedMaterializations(limit)
  const results: MaterializeResult[] = []
  for (const job of jobs) {
    results.push(await materializeOne(job))
  }
  return results
}

async function materializeOne(job: InboundMaterializationRow): Promise<MaterializeResult> {
  const draft = await getInboundDraft(job.draftId)
  if (!draft) {
    // The draft was deleted (queue cap eviction, or an operator purge) between
    // accept and drain. Nothing to materialize, and nothing to retry.
    await markMaterializationFailed(job.draftId, "source draft no longer exists")
    return { draftId: job.draftId, status: "failed", error: "source draft no longer exists" }
  }
  if (draft.status !== "accepted") {
    // Defence in depth: only an accepted draft may materialize. A queue row for
    // anything else is a bug upstream, and acting on it would apply content the
    // operator never approved.
    await markMaterializationFailed(job.draftId, `draft is ${draft.status}, not accepted`)
    return { draftId: job.draftId, status: "failed", error: `draft is ${draft.status}` }
  }

  await markMaterializationRunning(job.draftId)
  try {
    const producedId = await materializeDraft(draft)
    await markMaterializationCompleted(job.draftId, producedId)
    return { draftId: job.draftId, status: "completed", producedId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markMaterializationFailed(job.draftId, message)
    return { draftId: job.draftId, status: "failed", error: message }
  }
}

/**
 * Create the live object for one accepted draft and return its id.
 *
 * Exported for the "retry this one" action in the review UI, which needs to
 * drive a single draft rather than a whole pass.
 */
export async function materializeDraft(draft: InboundDraftRow): Promise<string> {
  switch (draft.kind) {
    case "lesson":
      return materializeLesson(draft)
    case "skill":
      return materializeSkill(draft)
    case "note":
      return materializeNote(draft)
  }
}

/**
 * A lesson becomes a semantic memory.
 *
 * Routed through `storeExternalMemory`, not `createMemory`: that wrapper stamps
 * `external` provenance, applies the block-mode PII gate, and refuses to create
 * `procedural` memories. An external contributor may not rewrite the
 * assistant's working instructions by way of the review queue (ADR-0069).
 *
 * The envelope is stripped for the stored text — a memory is retrieved into a
 * prompt by the memory subsystem, which applies its own fencing, and a doubly
 * fenced body renders as literal tag text to the reader.
 */
async function materializeLesson(draft: InboundDraftRow): Promise<string> {
  const { storeExternalMemory } = await import("@/lib/memory/api/store-memory")
  const text = stripUntrustedEnvelope(materializableBody(draft)).trim()
  const tags = readStringArray(draft.metadata?.tags)

  const result = await storeExternalMemory(
    { text, type: "semantic", tags: tags.length > 0 ? tags : undefined },
    { channel: "mcp" }
  )
  if (!result.ok) {
    // Surfaced verbatim so the review UI can tell "memory is off" apart from
    // "temporary mode" apart from "the text tripped the PII gate".
    throw new Error(`memory store refused: ${result.reason}`)
  }
  // The memory consolidator may decide the fact is already captured (NOOP) or
  // fold it into an existing row (UPDATE); either way there is no new row to
  // point at. That is a success — the lesson was captured — so it must not be
  // recorded as a failure the operator is invited to retry forever.
  return result.memoryId ?? CONSOLIDATED_INTO_EXISTING
}

/**
 * `producedId` sentinel for a lesson the memory consolidator merged into an
 * existing memory rather than storing as a new row. The review UI renders this
 * as "merged into an existing memory" instead of a dead link.
 */
export const CONSOLIDATED_INTO_EXISTING = "consolidated-into-existing"

/**
 * A skill draft becomes a real Skill — created `disabled`. See the module note.
 */
async function materializeSkill(draft: InboundDraftRow): Promise<string> {
  const { createSkill, listSkills } = await import("@/lib/db/skills")

  // Idempotency probe: a retry after a partial success must not create a second
  // Skill. `canonicalId` is the stable per-draft handle.
  const canonicalId = `inbound:${draft.id}`
  const existing = (await listSkills()).find((s) => s.canonicalId === canonicalId)
  if (existing) return existing.id

  const content = stripUntrustedEnvelope(materializableBody(draft)).trim()
  const description =
    typeof draft.metadata?.description === "string" ? draft.metadata.description : undefined

  const skill = await createSkill({
    name: draft.title,
    content,
    description,
    canonicalId,
    source: "imported",
    // Never `enabled`. Accepting a draft is not authorization to act on it.
    status: "disabled",
    tags: readStringArray(draft.metadata?.tags),
  })
  return skill.id
}

/** A note becomes a `knowledgeNotes` row, envelope intact. */
async function materializeNote(draft: InboundDraftRow): Promise<string> {
  const existing = await findKnowledgeNoteBySourceDraft(draft.id)
  if (existing) return existing.id

  const id = `kn_${draft.id}`
  await addKnowledgeNote({
    id,
    title: draft.title,
    // Kept wrapped: a note is displayed and fed back to models as external
    // content, and the envelope is what marks it as such.
    body: materializableBody(draft),
    tags: readStringArray(draft.metadata?.tags),
    sourceDraftId: draft.id,
    createdAt: Date.now(),
    ...(draft.source ? { source: draft.source } : {}),
    ...(typeof draft.metadata?.url === "string" ? { url: draft.metadata.url } : {}),
  })
  return id
}

/** Retry one previously-failed job immediately, bypassing the queue order. */
export async function retryMaterializationNow(draftId: string): Promise<MaterializeResult> {
  const job = await getInboundMaterialization(draftId)
  if (!job) return { draftId, status: "skipped", error: "no materialization queued" }
  return materializeOne(job)
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
}
