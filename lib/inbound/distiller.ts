/**
 * InboundDistiller — the single path by which anything external becomes a
 * pending review draft (ADR-0008 Phases 4–6).
 *
 * Three producers feed it and MUST NOT each roll their own pipeline:
 *
 *   • MCP write tools   — `record_lesson` / `save_skill_draft` / `ingest_note`
 *   • IDE log scanners  — Claude Code, Cursor, Cline, custom paths
 *   • Scheduler crawler — URLs, RSS, sitemaps
 *
 * The stages run in this order, and the order is the security property:
 *
 *   1. validate      — bound the sizes before anything else touches the text
 *   2. canonical hash — dedup against the existing queue
 *   3. redact        — strip PII *before* any model sees the content
 *   4. gate          — consent + PII + provider/network, checked as a unit
 *   5. classify      — optional, tool-free LLM structuring
 *   6. schema-check  — the model's output is untrusted too
 *   7. wrap + persist — `<untrusted_content>`, status `pending`
 *
 * ## What this module refuses to do
 *
 * It never writes live state. The output is always a `pending` draft; turning
 * one into a memory / Skill / note happens only after an operator accepts it,
 * in `lib/inbound/materializer.ts`. That separation is what makes the inbound
 * surface safe to leave enabled.
 *
 * It never calls a model before {@link InboundGate} says yes. Redaction runs
 * first regardless, so a gate misconfiguration cannot leak raw PII to a
 * provider — the redactor is not the gate's job to remember.
 *
 * The classifier runs with NO tools. A tool-enabled classifier reading attacker
 * text is a direct prompt-injection-to-tool-call path, and there is nothing the
 * classifier legitimately needs tools for.
 */

import {
  addInboundDraft,
  type InboundDraftKind,
  type InboundDraftRow,
} from "@/lib/db/inbound-drafts"
import { getDb } from "@/lib/db/schema"
import { wrapUntrusted } from "@/lib/external-bridge/untrusted"
import { redactText } from "@cognia/redact"
import { computeCanonicalHash } from "./canonical-hash"

/** Max characters accepted for a submitted body — bounds a hostile submission. */
export const MAX_INBOUND_BODY_CHARS = 100_000
/** Max characters kept for a title. */
export const MAX_INBOUND_TITLE_CHARS = 200
/** Max characters kept for a source label. */
export const MAX_INBOUND_SOURCE_CHARS = 200

/** Where a submission came from. Recorded on the draft for the review UI. */
export type InboundOrigin = "mcp" | "ide-scanner" | "crawler" | "agent-finding"

export interface InboundSubmission {
  kind: InboundDraftKind
  title: string
  body: string
  origin: InboundOrigin
  /** Free-form structured metadata (tags, skill trigger, source url, …). */
  metadata?: Record<string, unknown>
  /** Which external caller submitted it (device id / agent label, if known). */
  source?: string
  /**
   * What to call `title` / `body` in validation errors.
   *
   * The producers each expose these two slots under their own parameter names —
   * `lesson`, `instructions`, `note` — and an MCP client that gets back
   * "body must not be empty" has to guess which of its arguments was wrong.
   * Defaults to the generic names for producers with no better label.
   */
  fieldLabels?: { title?: string; body?: string }
}

/**
 * Permission surface the distiller consults before any model call.
 *
 * Injected rather than imported so the three producers can supply their own
 * policy — a crawler's network consent is not an MCP client's scope grant —
 * and so tests can assert the gate is actually honoured.
 */
export interface InboundGate {
  /**
   * May this submission be sent to a model for classification?
   *
   * Returning `false` is not an error: the distiller falls back to storing the
   * submission verbatim. Refusing to classify must never mean refusing to
   * record, or a provider outage would silently drop inbound knowledge.
   */
  allowsModelCall(submission: InboundSubmission): Promise<boolean> | boolean
}

/** Tool-free structuring pass. Optional — omitted means "store verbatim". */
export interface InboundClassifier {
  /**
   * Return a refined title/summary/tags for a submission, or `null` to keep the
   * original. Implementations MUST NOT be given tools.
   */
  classify(input: {
    kind: InboundDraftKind
    title: string
    /** Already redacted. Implementations never see raw PII. */
    body: string
  }): Promise<InboundClassification | null>
}

export interface InboundClassification {
  title?: string
  summary?: string
  tags?: string[]
}

export interface DistillDeps {
  gate: InboundGate
  classifier?: InboundClassifier
  /** Injected for deterministic tests. */
  now?: () => number
  newId?: () => string
}

export type DistillOutcome =
  | { status: "created"; draft: InboundDraftRow }
  /** An equivalent draft is already in the queue; `draftId` is the existing one. */
  | { status: "duplicate"; draftId: string; canonicalHash: string }
  | { status: "rejected"; reason: string }

/** Thrown for input that is malformed rather than merely unwanted. */
export class InboundValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InboundValidationError"
  }
}

function requireText(value: string, field: string, max: number): string {
  const trimmed = (value ?? "").trim()
  if (trimmed.length === 0) throw new InboundValidationError(`${field} must not be empty`)
  if (trimmed.length > max) {
    throw new InboundValidationError(`${field} exceeds ${max} characters`)
  }
  return trimmed
}

/**
 * Validate a classifier's response.
 *
 * The classifier read attacker-controlled text, so its output is attacker-
 * influenced and gets the same treatment as the original submission: bounded
 * lengths, string-typed fields only, tags capped and de-duplicated. A model
 * that returns a 10 MB "title" must not be able to write one.
 */
export function validateClassification(raw: unknown): InboundClassification | null {
  if (raw === null || typeof raw !== "object") return null
  const candidate = raw as Record<string, unknown>

  const result: InboundClassification = {}
  if (typeof candidate.title === "string" && candidate.title.trim()) {
    result.title = candidate.title.trim().slice(0, MAX_INBOUND_TITLE_CHARS)
  }
  if (typeof candidate.summary === "string" && candidate.summary.trim()) {
    result.summary = candidate.summary.trim().slice(0, 2000)
  }
  if (Array.isArray(candidate.tags)) {
    const tags = candidate.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().slice(0, 60))
      .filter(Boolean)
    if (tags.length > 0) result.tags = Array.from(new Set(tags)).slice(0, 20)
  }

  return Object.keys(result).length > 0 ? result : null
}

/**
 * Run a submission through the full pipeline and, if it survives, create one
 * `pending` draft.
 *
 * @throws {InboundValidationError} for empty or oversized title/body.
 */
export async function distillInbound(
  submission: InboundSubmission,
  deps: DistillDeps
): Promise<DistillOutcome> {
  // ── 1. Validate. Bound the sizes before anything else touches the text.
  const titleLabel = submission.fieldLabels?.title ?? "title"
  const bodyLabel = submission.fieldLabels?.body ?? "body"
  const title = requireText(submission.title, titleLabel, MAX_INBOUND_TITLE_CHARS)
  const body = requireText(submission.body, bodyLabel, MAX_INBOUND_BODY_CHARS)

  // ── 2. Dedup. Computed on the ORIGINAL text: redaction is deterministic but
  // its placeholder numbering is not stable across runs, so hashing the
  // redacted form would make the same page hash differently on each crawl.
  const canonicalHash = await computeCanonicalHash({ kind: submission.kind, title, body })
  const existing = await getDb().inboundDrafts.where("canonicalHash").equals(canonicalHash).first()
  if (existing) {
    return { status: "duplicate", draftId: existing.id, canonicalHash }
  }

  // ── 3. Redact BEFORE any model call. Deliberately not inside the gate
  // branch: a gate misconfiguration must not become a PII leak.
  const redactedBody = redactText(body).redacted
  const redactedTitle = redactText(title).redacted

  // ── 4/5. Gate, then classify. A refusal to classify is not a refusal to
  // record — a provider outage must not silently drop inbound knowledge.
  let classification: InboundClassification | null = null
  if (deps.classifier && (await deps.gate.allowsModelCall(submission))) {
    const raw = await deps.classifier
      .classify({ kind: submission.kind, title: redactedTitle, body: redactedBody })
      // A classifier that throws degrades to verbatim storage rather than
      // failing the whole submission.
      .catch(() => null)
    // ── 6. The model's output is untrusted too.
    classification = validateClassification(raw)
  }

  // ── 7. Wrap and persist as pending. Never live state.
  const now = deps.now?.() ?? Date.now()
  const metadata: Record<string, unknown> = { ...submission.metadata, origin: submission.origin }
  if (classification?.summary) metadata.summary = classification.summary
  if (classification?.tags) {
    const existingTags = Array.isArray(submission.metadata?.tags)
      ? (submission.metadata.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : []
    metadata.tags = Array.from(new Set([...existingTags, ...classification.tags]))
  }

  const draft: InboundDraftRow = {
    id: deps.newId?.() ?? crypto.randomUUID(),
    kind: submission.kind,
    status: "pending",
    title: classification?.title ?? redactedTitle,
    body: wrapUntrusted(redactedBody),
    metadata,
    canonicalHash,
    createdAt: now,
    ...(submission.source ? { source: submission.source.slice(0, MAX_INBOUND_SOURCE_CHARS) } : {}),
  }
  await addInboundDraft(draft)
  return { status: "created", draft }
}

/**
 * A gate that never permits a model call.
 *
 * The correct default for a producer that has not yet established consent —
 * every submission is still recorded, just stored verbatim instead of being
 * classified.
 */
export const DENY_MODEL_GATE: InboundGate = { allowsModelCall: () => false }
