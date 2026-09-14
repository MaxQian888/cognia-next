/**
 * The host's answer to `session_reference_search` and `session_reference_snapshot`.
 *
 * Reached through the desktop-write bridge (`lib/companion/desktop-write-source.ts`)
 * on both hosts, the desktop renderer and the headless brain. It runs the exact
 * reads the host's own composer runs for `@msg:`, `@prompt:` and `^`
 * (`localHistoryReference`), so a phone sees the list the desktop would show for
 * the same query — the same exposure and archive rules, the same authorship
 * check for prompts, the same workspace scope. The device side is
 * `host-references.ts`.
 *
 * Nothing here decides what a record may contain beyond what the host's own
 * picker would stage; it only bounds what one response carries.
 */

import { truncationMarker } from "@/lib/docs-providers/limits"

import { ENTITY_MENTION_RESULT_LIMIT, MAX_ENTITY_SNAPSHOT_CHARS } from "./entity-sources"
import type { EntityMentionCandidate } from "./entity-sources"
import {
  SESSION_REFERENCE_ID_MAX_CHARS,
  SESSION_REFERENCE_QUERY_MAX_CHARS,
  SESSION_REFERENCE_SEARCH_COMMAND,
  SESSION_REFERENCE_SNAPSHOT_COMMAND,
  SESSION_REFERENCE_SNAPSHOT_MAX_IDS,
  isHistoryReferenceKind,
  type SessionReferenceRecord,
  type SessionReferenceSearchRequest,
  type SessionReferenceSearchResponse,
  type SessionReferenceSnapshotRequest,
  type SessionReferenceSnapshotResponse,
  type SessionReferenceWireCandidate,
} from "./host-references"

/**
 * Characters of one body a response carries.
 *
 * Twice what a staged chip keeps, so the device's own clamp still decides where
 * a long record is cut and appends the marker the model reads. The ceiling only
 * stops one enormous tool output from riding the bridge whole.
 */
export const SESSION_REFERENCE_BODY_MAX_CHARS = MAX_ENTITY_SNAPSHOT_CHARS * 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalid(command: string, detail: string): Error {
  return new Error(`${command}: ${detail}`)
}

function optionalId(command: string, value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.length > SESSION_REFERENCE_ID_MAX_CHARS) {
    throw invalid(command, `${field} must be a string`)
  }
  return value || undefined
}

export function parseSessionReferenceSearchRequest(
  payload: unknown
): SessionReferenceSearchRequest {
  const command = SESSION_REFERENCE_SEARCH_COMMAND
  if (!isRecord(payload)) throw invalid(command, "payload must be an object")
  if (!isHistoryReferenceKind(payload.kind)) {
    throw invalid(command, "kind must be message, prompt or result")
  }
  if (
    typeof payload.query !== "string" ||
    payload.query.length > SESSION_REFERENCE_QUERY_MAX_CHARS
  ) {
    throw invalid(command, `query must be a string of at most ${SESSION_REFERENCE_QUERY_MAX_CHARS}`)
  }
  const projectId = optionalId(command, payload.projectId, "projectId")
  const sessionId = optionalId(command, payload.sessionId, "sessionId")
  return {
    kind: payload.kind,
    query: payload.query,
    ...(projectId ? { projectId } : {}),
    ...(sessionId ? { sessionId } : {}),
  }
}

export function parseSessionReferenceSnapshotRequest(
  payload: unknown
): SessionReferenceSnapshotRequest {
  const command = SESSION_REFERENCE_SNAPSHOT_COMMAND
  if (!isRecord(payload)) throw invalid(command, "payload must be an object")
  if (!isHistoryReferenceKind(payload.kind)) {
    throw invalid(command, "kind must be message, prompt or result")
  }
  const ids = payload.ids
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > SESSION_REFERENCE_SNAPSHOT_MAX_IDS ||
    !ids.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= SESSION_REFERENCE_ID_MAX_CHARS
    )
  ) {
    throw invalid(command, `ids must name 1 to ${SESSION_REFERENCE_SNAPSHOT_MAX_IDS} records`)
  }
  if (typeof payload.withBody !== "boolean") {
    throw invalid(command, "withBody must be a boolean")
  }
  return { kind: payload.kind, ids: [...new Set(ids as string[])], withBody: payload.withBody }
}

/**
 * A candidate as it crosses the wire.
 *
 * `insertText` is dropped rather than cut when it is too long: putting half of
 * an old prompt back into the draft would send words the user never wrote as a
 * whole. The row can still be referenced.
 */
export function wireCandidate(candidate: EntityMentionCandidate): SessionReferenceWireCandidate {
  const insertText =
    candidate.insertText && candidate.insertText.length <= SESSION_REFERENCE_BODY_MAX_CHARS
      ? candidate.insertText
      : undefined
  return {
    id: candidate.id,
    title: candidate.title,
    ...(candidate.subtitle ? { subtitle: candidate.subtitle } : {}),
    ...(candidate.href ? { href: candidate.href } : {}),
    ...(candidate.sourceSessionId ? { sourceSessionId: candidate.sourceSessionId } : {}),
    ...(insertText ? { insertText } : {}),
  }
}

export function clampReferenceBody(text: string): string {
  if (text.length <= SESSION_REFERENCE_BODY_MAX_CHARS) return text
  return (
    text.slice(0, SESSION_REFERENCE_BODY_MAX_CHARS) +
    truncationMarker("this record", SESSION_REFERENCE_BODY_MAX_CHARS, "characters")
  )
}

export async function sessionReferenceSearch(
  payload: unknown
): Promise<SessionReferenceSearchResponse> {
  const request = parseSessionReferenceSearchRequest(payload)
  const { localHistoryReference } = await import("./entity-sources")
  const candidates = await localHistoryReference(request.kind).search(request.query.trim(), {
    projectId: request.projectId ?? null,
    sessionId: request.sessionId ?? null,
  })
  return { candidates: candidates.slice(0, ENTITY_MENTION_RESULT_LIMIT).map(wireCandidate) }
}

export async function sessionReferenceSnapshot(
  payload: unknown
): Promise<SessionReferenceSnapshotResponse> {
  const request = parseSessionReferenceSnapshotRequest(payload)
  const { localHistoryReference } = await import("./entity-sources")
  const local = localHistoryReference(request.kind)
  const records = await Promise.all(
    request.ids.map(async (id): Promise<SessionReferenceRecord> => {
      if (!request.withBody) return { id, fingerprint: await local.fingerprint(id) }
      const [fingerprint, body] = await Promise.all([local.fingerprint(id), local.snapshot(id)])
      return { id, fingerprint, body: body === null ? null : clampReferenceBody(body) }
    })
  )
  return { records }
}
