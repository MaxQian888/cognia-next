/**
 * MCP tool handlers — inbound write tools (ADR-0008 Phase 4).
 *
 * Three write tools let an external coding agent contribute back to Cognia:
 *
 *   • `record_lesson`     — a lesson learned / correction worth remembering.
 *   • `save_skill_draft`  — a proposed skill (name + instructions).
 *   • `ingest_note`       — a free-form note / snippet to file for later.
 *
 * None of these mutate live Cognia state. Every submission goes through the
 * shared `InboundDistiller` (`lib/inbound/distiller.ts`) — the same pipeline the
 * IDE scanners and the crawler use — and lands in the `inboundDrafts` review
 * queue as `pending` for the operator to accept or reject. Only acceptance
 * materializes anything, and that happens in `lib/inbound/materializer.ts`.
 *
 * These handlers deliberately hold no pipeline logic of their own: validation,
 * dedup, PII redaction, and `<untrusted_content>` fencing (ADR-0008 R7) all
 * live in the distiller, so a fourth producer cannot be added later with a
 * subtly different — or absent — set of protections. All three tools are gated
 * behind the single `inbound:write` scope (default OFF); the MCP server layer
 * (`lib/external-bridge/mcp-server`) owns that gate and the audit log.
 */

import type { InboundDraftKind } from "@/lib/db/inbound-drafts"
import {
  DENY_MODEL_GATE,
  distillInbound,
  MAX_INBOUND_BODY_CHARS,
  MAX_INBOUND_TITLE_CHARS,
  type DistillDeps,
  type InboundGate,
} from "@/lib/inbound/distiller"

export { MAX_INBOUND_BODY_CHARS, MAX_INBOUND_TITLE_CHARS }

export interface InboundWriteResult {
  ok: true
  draftId: string
  kind: InboundDraftKind
  status: "pending"
  /**
   * True when an equivalent draft was already queued and this submission was
   * folded into it. Reported rather than hidden so a scanner or crawler can
   * tell "recorded" from "already had it" without re-reading the queue.
   */
  duplicate: boolean
}

/**
 * Distiller wiring for the MCP surface.
 *
 * No classifier and a deny-all model gate: an MCP submission arrives already
 * structured (the tool schema supplies the title and the kind), so there is
 * nothing for a classification pass to add, and sending an external agent's
 * text to a model to learn that would be an unrequested outbound call on the
 * user's account. The scanners and crawler — whose input is unstructured — are
 * where a classifier earns its keep.
 */
function mcpDeps(overrides?: Partial<DistillDeps>): DistillDeps {
  return { gate: DENY_MODEL_GATE, ...overrides }
}

async function submit(
  kind: InboundDraftKind,
  title: string,
  body: string,
  metadata: Record<string, unknown> | undefined,
  source: string | undefined,
  // Named after the tool's own parameters so a validation error tells the
  // calling agent which argument to fix.
  fieldLabels: { title: string; body: string },
  deps?: Partial<DistillDeps>
): Promise<InboundWriteResult> {
  const outcome = await distillInbound(
    { kind, title, body, origin: "mcp", metadata, source, fieldLabels },
    mcpDeps(deps)
  )
  if (outcome.status === "duplicate") {
    return { ok: true, draftId: outcome.draftId, kind, status: "pending", duplicate: true }
  }
  if (outcome.status === "rejected") {
    throw new Error(outcome.reason)
  }
  return { ok: true, draftId: outcome.draft.id, kind, status: "pending", duplicate: false }
}

export interface RecordLessonInput {
  title: string
  lesson: string
  tags?: string[]
  source?: string
}

export async function recordLesson(
  input: RecordLessonInput,
  deps?: Partial<DistillDeps>
): Promise<InboundWriteResult> {
  const tags = input.tags?.map((t) => t.trim()).filter(Boolean)
  return submit(
    "lesson",
    input.title,
    input.lesson,
    tags?.length ? { tags } : undefined,
    input.source,
    { title: "title", body: "lesson" },
    deps
  )
}

export interface SaveSkillDraftInput {
  name: string
  instructions: string
  description?: string
  trigger?: string
  source?: string
}

export async function saveSkillDraft(
  input: SaveSkillDraftInput,
  deps?: Partial<DistillDeps>
): Promise<InboundWriteResult> {
  const metadata: Record<string, unknown> = {}
  if (input.description?.trim()) metadata.description = input.description.trim()
  if (input.trigger?.trim()) metadata.trigger = input.trigger.trim()
  return submit(
    "skill",
    input.name,
    input.instructions,
    Object.keys(metadata).length ? metadata : undefined,
    input.source,
    { title: "name", body: "instructions" },
    deps
  )
}

export interface IngestNoteInput {
  title: string
  note: string
  url?: string
  source?: string
}

export async function ingestNote(
  input: IngestNoteInput,
  deps?: Partial<DistillDeps>
): Promise<InboundWriteResult> {
  const metadata = input.url?.trim() ? { url: input.url.trim() } : undefined
  return submit(
    "note",
    input.title,
    input.note,
    metadata,
    input.source,
    { title: "title", body: "note" },
    deps
  )
}

export type { InboundGate }
