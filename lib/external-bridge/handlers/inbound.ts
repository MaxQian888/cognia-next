/**
 * MCP tool handlers — inbound write tools (ADR-0008 Phase 4).
 *
 * Three write tools let an external coding agent contribute back to Cognia:
 *
 *   • `record_lesson`     — a lesson learned / correction worth remembering.
 *   • `save_skill_draft`  — a proposed skill (name + instructions).
 *   • `ingest_note`       — a free-form note / snippet to file for later.
 *
 * None of these mutate live Cognia state. Every submission lands in the
 * `inboundDrafts` review queue (`status: "pending"`) for the operator (a future
 * review UI / `InboundDistiller`) to accept or discard. The submitted body is
 * wrapped in `<untrusted_content>` tags (ADR-0008 R7) so any downstream
 * consumer treats it as untrusted (prompt-injection defence). All three are
 * gated behind the single `inbound:write` scope (default OFF).
 *
 * Pure handlers — validation + a Dexie write. The MCP server layer
 * (`lib/external-bridge/mcp-server`) owns the permission gate + audit log.
 */

import { addInboundDraft, type InboundDraftKind } from "@/lib/db/inbound-drafts"
import { wrapUntrusted } from "../untrusted"

/** Max characters accepted for a submitted body — bounds a hostile submission. */
export const MAX_INBOUND_BODY_CHARS = 100_000
/** Max characters kept for a title. */
export const MAX_INBOUND_TITLE_CHARS = 200

export interface InboundWriteResult {
  ok: true
  draftId: string
  kind: InboundDraftKind
  status: "pending"
}

function requireText(value: string, field: string, max: number): string {
  const trimmed = (value ?? "").trim()
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty`)
  }
  if (trimmed.length > max) {
    throw new Error(`${field} exceeds ${max} characters`)
  }
  return trimmed
}

async function persist(
  kind: InboundDraftKind,
  title: string,
  body: string,
  metadata: Record<string, unknown> | undefined,
  source: string | undefined
): Promise<InboundWriteResult> {
  const id = crypto.randomUUID()
  await addInboundDraft({
    id,
    kind,
    status: "pending",
    // `title` is already validated to be non-empty and ≤ MAX_INBOUND_TITLE_CHARS.
    title,
    body: wrapUntrusted(body),
    metadata,
    source: source?.slice(0, 200),
    createdAt: Date.now(),
  })
  return { ok: true, draftId: id, kind, status: "pending" }
}

export interface RecordLessonInput {
  title: string
  lesson: string
  tags?: string[]
  source?: string
}

export async function recordLesson(input: RecordLessonInput): Promise<InboundWriteResult> {
  const title = requireText(input.title, "title", MAX_INBOUND_TITLE_CHARS)
  const lesson = requireText(input.lesson, "lesson", MAX_INBOUND_BODY_CHARS)
  const tags = input.tags?.map((t) => t.trim()).filter(Boolean)
  return persist("lesson", title, lesson, tags?.length ? { tags } : undefined, input.source)
}

export interface SaveSkillDraftInput {
  name: string
  instructions: string
  description?: string
  trigger?: string
  source?: string
}

export async function saveSkillDraft(input: SaveSkillDraftInput): Promise<InboundWriteResult> {
  const name = requireText(input.name, "name", MAX_INBOUND_TITLE_CHARS)
  const instructions = requireText(input.instructions, "instructions", MAX_INBOUND_BODY_CHARS)
  const metadata: Record<string, unknown> = {}
  if (input.description?.trim()) metadata.description = input.description.trim()
  if (input.trigger?.trim()) metadata.trigger = input.trigger.trim()
  return persist(
    "skill",
    name,
    instructions,
    Object.keys(metadata).length ? metadata : undefined,
    input.source
  )
}

export interface IngestNoteInput {
  title: string
  note: string
  url?: string
  source?: string
}

export async function ingestNote(input: IngestNoteInput): Promise<InboundWriteResult> {
  const title = requireText(input.title, "title", MAX_INBOUND_TITLE_CHARS)
  const note = requireText(input.note, "note", MAX_INBOUND_BODY_CHARS)
  const metadata = input.url?.trim() ? { url: input.url.trim() } : undefined
  return persist("note", title, note, metadata, input.source)
}
