/**
 * `@msg:`, `@prompt:` and `^` on a paired device — answered by the host that
 * holds the history.
 *
 * Every other `@` source reads a table a paired device mirrors whole: memories,
 * issues, plans, the conversation list. History is the exception. Companion
 * sync pulls the recent end of each conversation (`lib/sync/handlers/messages.ts`)
 * and older turns only when someone scrolls into them, so the search index a
 * phone builds covers a fragment — and the thing a person reaches for `@msg:`
 * to find is usually the part that is not there. A result picked from a list
 * the host produced may not exist on the device at all, so its body and its
 * fingerprint have to come from the host too.
 *
 * Two commands over the desktop-write bridge, answered on the host by
 * `host-reference-rpc.ts` with the same local reads the host's own composer
 * runs (`localHistoryReference`):
 *
 * - `session_reference_search` — one kind's candidates for a query.
 * - `session_reference_snapshot` — records by id: always their fingerprints, and
 *   their bodies when asked. Fingerprints alone are what the staleness check
 *   asks for, for every chip on every window focus, so one call answers a
 *   whole combined reference instead of one call per message.
 *
 * When the host cannot answer, search falls back to the device's copy and says
 * so (`reach: "device-copy"`); a body falls back to the copy only when the copy
 * has the record. A fingerprint never falls back: the copy's digest is not the
 * host's, and "missing here" would read as "deleted" — so the check fails and
 * the chip stays as it was, which is what a failed check already means.
 */

import { loggers } from "@cognia/logging"
import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import type { Transport } from "@/lib/tauri/transport-types"

import type {
  EntityMentionCandidate,
  EntityMentionContext,
  EntityMentionSearchPage,
  LocalHistoryReference,
} from "./entity-sources"

/** The entity kinds whose records are conversation history. */
export const HISTORY_REFERENCE_KINDS = ["message", "prompt", "result"] as const

export type HistoryReferenceKind = (typeof HISTORY_REFERENCE_KINDS)[number]

export const SESSION_REFERENCE_SEARCH_COMMAND = "session_reference_search"
export const SESSION_REFERENCE_SNAPSHOT_COMMAND = "session_reference_snapshot"

/** Longest query sent. Far past anything typed into a picker. */
export const SESSION_REFERENCE_QUERY_MAX_CHARS = 500

/** Records one `session_reference_snapshot` call may name. */
export const SESSION_REFERENCE_SNAPSHOT_MAX_IDS = 50

/** Longest record id accepted. Session and message ids are far shorter. */
export const SESSION_REFERENCE_ID_MAX_CHARS = 1_000

export interface SessionReferenceSearchRequest {
  kind: HistoryReferenceKind
  query: string
  projectId?: string
  sessionId?: string
}

/** A candidate as it crosses the wire: the kind is the request's. */
export interface SessionReferenceWireCandidate {
  id: string
  title: string
  subtitle?: string
  href?: string
  sourceSessionId?: string
  insertText?: string
}

export interface SessionReferenceSearchResponse {
  candidates: SessionReferenceWireCandidate[]
}

export interface SessionReferenceSnapshotRequest {
  kind: HistoryReferenceKind
  ids: string[]
  withBody: boolean
}

export interface SessionReferenceRecord {
  id: string
  /** `null`: the record is gone on the host. */
  fingerprint: string | null
  /** Present only when the request asked for bodies; `null` when gone. */
  body?: string | null
}

export interface SessionReferenceSnapshotResponse {
  records: SessionReferenceRecord[]
}

export function isHistoryReferenceKind(value: unknown): value is HistoryReferenceKind {
  return (HISTORY_REFERENCE_KINDS as readonly unknown[]).includes(value)
}

/**
 * Does this shell's history live on a host it is paired to?
 *
 * Keyed on the profile, not on `!isTauri()`: a standalone browser has no host
 * to ask and its own database IS its history, and the headless brain is the
 * host. Only the two companion profiles hold a partial copy.
 */
export function historyReferencesLiveOnHost(profile: HostProfile = detectHostProfile()): boolean {
  return profile === "mobile-companion" || profile === "cloud-companion"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function malformed(command: string): Error {
  return new Error(`${command} answered with a malformed response`)
}

function parseSearchResponse(value: unknown): SessionReferenceWireCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    throw malformed(SESSION_REFERENCE_SEARCH_COMMAND)
  }
  return value.candidates.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string") {
      throw malformed(SESSION_REFERENCE_SEARCH_COMMAND)
    }
    const subtitle = optionalString(item.subtitle)
    const href = optionalString(item.href)
    const sourceSessionId = optionalString(item.sourceSessionId)
    const insertText = optionalString(item.insertText)
    return {
      id: item.id,
      title: item.title,
      ...(subtitle ? { subtitle } : {}),
      ...(href ? { href } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      ...(insertText ? { insertText } : {}),
    }
  })
}

function parseSnapshotResponse(value: unknown, withBody: boolean): SessionReferenceRecord[] {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    throw malformed(SESSION_REFERENCE_SNAPSHOT_COMMAND)
  }
  return value.records.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !(typeof item.fingerprint === "string" || item.fingerprint === null)
    ) {
      throw malformed(SESSION_REFERENCE_SNAPSHOT_COMMAND)
    }
    if (!withBody) return { id: item.id, fingerprint: item.fingerprint }
    if (!(typeof item.body === "string" || item.body === null)) {
      throw malformed(SESSION_REFERENCE_SNAPSHOT_COMMAND)
    }
    return { id: item.id, fingerprint: item.fingerprint, body: item.body }
  })
}

/** Rebuild the candidate the panel and the staging path expect. */
export function candidateFromWire(
  kind: HistoryReferenceKind,
  wire: SessionReferenceWireCandidate
): EntityMentionCandidate {
  return {
    entityKind: kind,
    id: wire.id,
    title: wire.title,
    ...(wire.subtitle ? { subtitle: wire.subtitle } : {}),
    ...(wire.href ? { href: wire.href } : {}),
    ...(wire.sourceSessionId ? { sourceSessionId: wire.sourceSessionId } : {}),
    ...(wire.insertText ? { insertText: wire.insertText } : {}),
    searchText: [wire.title, wire.subtitle].filter(Boolean).join(" ").toLocaleLowerCase(),
  }
}

export interface HostHistoryReferenceClient {
  search(
    kind: HistoryReferenceKind,
    query: string,
    ctx: EntityMentionContext
  ): Promise<EntityMentionCandidate[]>
  /** One record with its body. */
  read(kind: HistoryReferenceKind, id: string): Promise<SessionReferenceRecord>
  /**
   * One record's fingerprint. Calls made in the same turn of the event loop
   * share one request per kind, so a combined reference of twelve messages is
   * checked in one round trip.
   */
  fingerprint(kind: HistoryReferenceKind, id: string): Promise<string | null>
}

type CallTransport = Pick<Transport, "call">

interface Waiter {
  resolve(fingerprint: string | null): void
  reject(error: unknown): void
}

export function createHostHistoryReferenceClient(
  resolveTransport: () => Promise<CallTransport>
): HostHistoryReferenceClient {
  const queued = new Map<HistoryReferenceKind, Map<string, Waiter[]>>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  async function requestRecords(
    kind: HistoryReferenceKind,
    ids: string[],
    withBody: boolean
  ): Promise<SessionReferenceRecord[]> {
    const transport = await resolveTransport()
    const request: SessionReferenceSnapshotRequest = { kind, ids, withBody }
    const response = await transport.call<unknown>(
      SESSION_REFERENCE_SNAPSHOT_COMMAND,
      request as unknown as Record<string, unknown>
    )
    return parseSnapshotResponse(response, withBody)
  }

  function settle(
    ids: readonly string[],
    waiters: Map<string, Waiter[]>,
    outcome: { records: SessionReferenceRecord[] } | { error: unknown }
  ): void {
    const byId =
      "records" in outcome ? new Map(outcome.records.map((record) => [record.id, record])) : null
    for (const id of ids) {
      for (const waiter of waiters.get(id) ?? []) {
        if (!byId) {
          waiter.reject((outcome as { error: unknown }).error)
          continue
        }
        const record = byId.get(id)
        // A host that skips an id has not said the record is gone, so this is
        // a failed check, not a `null`.
        if (record) waiter.resolve(record.fingerprint)
        else
          waiter.reject(new Error(`${SESSION_REFERENCE_SNAPSHOT_COMMAND} did not answer for ${id}`))
      }
    }
  }

  function flush(): void {
    flushTimer = null
    const batches = [...queued.entries()]
    queued.clear()
    for (const [kind, waiters] of batches) {
      const ids = [...waiters.keys()]
      for (let start = 0; start < ids.length; start += SESSION_REFERENCE_SNAPSHOT_MAX_IDS) {
        const chunk = ids.slice(start, start + SESSION_REFERENCE_SNAPSHOT_MAX_IDS)
        requestRecords(kind, chunk, false).then(
          (records) => settle(chunk, waiters, { records }),
          (error: unknown) => settle(chunk, waiters, { error })
        )
      }
    }
  }

  return {
    async search(kind, query, ctx) {
      const transport = await resolveTransport()
      const request: SessionReferenceSearchRequest = {
        kind,
        query: query.slice(0, SESSION_REFERENCE_QUERY_MAX_CHARS),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      }
      const response = await transport.call<unknown>(
        SESSION_REFERENCE_SEARCH_COMMAND,
        request as unknown as Record<string, unknown>
      )
      return parseSearchResponse(response).map((wire) => candidateFromWire(kind, wire))
    },

    async read(kind, id) {
      const [record] = (await requestRecords(kind, [id], true)).filter((row) => row.id === id)
      if (!record) {
        throw new Error(`${SESSION_REFERENCE_SNAPSHOT_COMMAND} did not answer for ${id}`)
      }
      return record
    },

    fingerprint(kind, id) {
      return new Promise<string | null>((resolve, reject) => {
        let waiters = queued.get(kind)
        if (!waiters) {
          waiters = new Map()
          queued.set(kind, waiters)
        }
        const list = waiters.get(id) ?? []
        list.push({ resolve, reject })
        waiters.set(id, list)
        // A macrotask, not a microtask: each caller reaches here after its own
        // `await import(...)`, and those continuations do not all land before a
        // microtask queued by the first one.
        flushTimer ??= setTimeout(flush, 0)
      })
    },
  }
}

let client: HostHistoryReferenceClient | null = null

function hostClient(): HostHistoryReferenceClient {
  client ??= createHostHistoryReferenceClient(async () => (await import("@/lib/tauri")).transport)
  return client
}

/** Test-only: swap the host client (`null` restores the default). */
export function __setHostHistoryReferenceClientForTests(
  next: HostHistoryReferenceClient | null
): void {
  client = next
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function searchHistoryReferences(
  kind: HistoryReferenceKind,
  query: string,
  ctx: EntityMentionContext,
  local: LocalHistoryReference
): Promise<EntityMentionSearchPage> {
  if (!historyReferencesLiveOnHost()) return { candidates: await local.search(query, ctx) }
  try {
    return { candidates: await hostClient().search(kind, query, ctx) }
  } catch (error) {
    loggers.chat.warn("history reference search could not reach the host", {
      entityKind: kind,
      err: reason(error),
    })
    return { candidates: await local.search(query, ctx), reach: "device-copy" }
  }
}

export async function snapshotHistoryReference(
  kind: HistoryReferenceKind,
  id: string,
  local: LocalHistoryReference
): Promise<string | null> {
  if (!historyReferencesLiveOnHost()) return local.snapshot(id)
  try {
    return (await hostClient().read(kind, id)).body ?? null
  } catch (error) {
    // The copy is only worth reading when it has the record. When it does not,
    // `null` would tell the user the record was deleted; the host's error is
    // the true answer.
    const copy = await local.snapshot(id).catch(() => null)
    if (copy === null) throw error
    loggers.chat.warn("history reference read fell back to this device's copy", {
      entityKind: kind,
      err: reason(error),
    })
    return copy
  }
}

export async function fingerprintHistoryReference(
  kind: HistoryReferenceKind,
  id: string,
  local: LocalHistoryReference
): Promise<string | null> {
  if (!historyReferencesLiveOnHost()) return local.fingerprint(id)
  return hostClient().fingerprint(kind, id)
}
