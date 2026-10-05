/**
 * SQLite storage of one sync space (protocol §5.6). The registry table is
 * append-only and authoritative; `meta.state` caches its fold, keyed by the
 * head hash, and is rebuilt whenever it does not match the last row.
 * Envelopes hold the current epoch only. Finished enrollment requests are
 * kept for an hour so devices can see how a request ended, then deleted.
 */

import type { EpochEnvelope, RegistryState, SignedEntry } from "@cognia/sync-protocol"

export const FINISHED_REQUEST_RETENTION_MS = 60 * 60 * 1000

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS registry (
     seq INTEGER PRIMARY KEY,
     hash TEXT NOT NULL UNIQUE,
     element TEXT NOT NULL,
     appended_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS envelopes (
     recipient TEXT PRIMARY KEY,
     epoch INTEGER NOT NULL,
     envelope TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS requests (
     request_id TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     platform TEXT NOT NULL,
     sign_pub TEXT NOT NULL,
     enc_pub TEXT NOT NULL,
     commit_hash TEXT NOT NULL,
     names TEXT NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     approver_device_id TEXT,
     nonce_a TEXT,
     nonce_r TEXT,
     entry_seq INTEGER,
     finished_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS requests_created ON requests (created_at)`,
  // The op log (protocol §7): one row per push, ops as their JSON array.
  `CREATE TABLE IF NOT EXISTS ops (
     first_seq INTEGER PRIMARY KEY,
     last_seq INTEGER NOT NULL,
     device_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     size INTEGER NOT NULL,
     ops TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS device_seqs (device_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)`,
  // How far each device has pulled; 3b drops tombstones only past every device.
  `CREATE TABLE IF NOT EXISTS acks (
     device_id TEXT PRIMARY KEY,
     ack_seq INTEGER NOT NULL,
     seen_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tickets (
     ticket TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
]

export interface OpBatch {
  firstSeq: number
  lastSeq: number
  deviceId: string
  /** The batch's ops, as stored (serverSeq of `ops[i]` is `firstSeq + i`). */
  ops: unknown[]
}

export const OPEN_REQUEST_STATES = ["pending", "nonce_set", "revealed"] as const
export const FINAL_REQUEST_STATES = [
  "approved",
  "denied",
  "mismatch",
  "cancelled",
  "expired",
] as const
export type OpenRequestState = (typeof OPEN_REQUEST_STATES)[number]
export type FinalRequestState = (typeof FINAL_REQUEST_STATES)[number]
export type RequestState = OpenRequestState | FinalRequestState

export function isOpenState(state: RequestState): state is OpenRequestState {
  return (OPEN_REQUEST_STATES as readonly string[]).includes(state)
}

export interface RequestRow {
  request_id: string
  device_id: string
  platform: string
  sign_pub: string
  enc_pub: string
  commit_hash: string
  /** JSON `SealedName[]`. */
  names: string
  state: RequestState
  created_at: number
  expires_at: number
  approver_device_id: string | null
  nonce_a: string | null
  nonce_r: string | null
  entry_seq: number | null
  finished_at: number | null
}

export interface RegistryRow {
  seq: number
  hash: string
  element: SignedEntry
}

type Row = Record<string, SqlStorageValue>

export class SpaceStore {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    for (const statement of SCHEMA) this.sql.exec(statement)
  }

  meta(key: string): string | null {
    const rows = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray()
    return rows[0]?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    )
  }

  registry(afterSeq: number, limit: number): RegistryRow[] {
    return this.sql
      .exec<{ seq: number; hash: string; element: string }>(
        "SELECT seq, hash, element FROM registry WHERE seq > ? ORDER BY seq LIMIT ?",
        afterSeq,
        limit
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        hash: row.hash,
        element: JSON.parse(row.element) as SignedEntry,
      }))
  }

  allElements(): SignedEntry[] {
    return this.sql
      .exec<{ element: string }>("SELECT element FROM registry ORDER BY seq")
      .toArray()
      .map((row) => JSON.parse(row.element) as SignedEntry)
  }

  head(): { seq: number; hash: string } | null {
    const rows = this.sql
      .exec<{ seq: number; hash: string }>(
        "SELECT seq, hash FROM registry ORDER BY seq DESC LIMIT 1"
      )
      .toArray()
    return rows[0] ?? null
  }

  appendEntry(seq: number, hash: string, element: SignedEntry, at: number): void {
    this.sql.exec(
      "INSERT INTO registry (seq, hash, element, appended_at) VALUES (?, ?, ?, ?)",
      seq,
      hash,
      JSON.stringify(element),
      at
    )
  }

  cachedState(headHash: string): RegistryState | null {
    const raw = this.meta("state")
    if (!raw) return null
    const cached = JSON.parse(raw) as { headHash: string; state: RegistryState }
    return cached.headHash === headHash ? cached.state : null
  }

  cacheState(state: RegistryState): void {
    this.setMeta("state", JSON.stringify({ headHash: state.head.hash, state }))
  }

  envelope(recipient: string): EpochEnvelope | null {
    const rows = this.sql
      .exec<{ envelope: string }>("SELECT envelope FROM envelopes WHERE recipient = ?", recipient)
      .toArray()
    return rows[0] ? (JSON.parse(rows[0].envelope) as EpochEnvelope) : null
  }

  envelopeRecipients(): string[] {
    return this.sql
      .exec<{ recipient: string }>("SELECT recipient FROM envelopes ORDER BY recipient")
      .toArray()
      .map((row) => row.recipient)
  }

  /** The current epoch's whole set, replacing the previous epoch's. */
  replaceEnvelopes(envelopes: readonly EpochEnvelope[]): void {
    this.sql.exec("DELETE FROM envelopes")
    for (const envelope of envelopes) this.putEnvelope(envelope)
  }

  putEnvelope(envelope: EpochEnvelope): void {
    this.sql.exec(
      "INSERT INTO envelopes (recipient, epoch, envelope) VALUES (?, ?, ?) ON CONFLICT(recipient) DO UPDATE SET epoch = excluded.epoch, envelope = excluded.envelope",
      envelope.recipient,
      envelope.epoch,
      JSON.stringify(envelope)
    )
  }

  request(requestId: string): RequestRow | null {
    return (
      (this.sql
        .exec<Row>("SELECT * FROM requests WHERE request_id = ?", requestId)
        .toArray()[0] as unknown as RequestRow) ?? null
    )
  }

  requests(): RequestRow[] {
    return this.sql
      .exec<Row>("SELECT * FROM requests ORDER BY created_at")
      .toArray() as unknown as RequestRow[]
  }

  insertRequest(row: RequestRow): void {
    this.sql.exec(
      `INSERT INTO requests (request_id, device_id, platform, sign_pub, enc_pub, commit_hash, names, state,
         created_at, expires_at, approver_device_id, nonce_a, nonce_r, entry_seq, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.request_id,
      row.device_id,
      row.platform,
      row.sign_pub,
      row.enc_pub,
      row.commit_hash,
      row.names,
      row.state,
      row.created_at,
      row.expires_at,
      row.approver_device_id,
      row.nonce_a,
      row.nonce_r,
      row.entry_seq,
      row.finished_at
    )
  }

  updateRequest(
    requestId: string,
    fields: Partial<
      Pick<
        RequestRow,
        "state" | "approver_device_id" | "nonce_a" | "nonce_r" | "entry_seq" | "finished_at"
      >
    >
  ): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[]
    if (keys.length === 0) return
    this.sql.exec(
      `UPDATE requests SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE request_id = ?`,
      ...keys.map((key) => fields[key] ?? null),
      requestId
    )
  }

  /** Open requests past their expiry become `expired`. */
  expireDue(now: number): number {
    const placeholders = OPEN_REQUEST_STATES.map(() => "?").join(", ")
    return this.sql.exec(
      `UPDATE requests SET state = 'expired', finished_at = ? WHERE expires_at <= ? AND state IN (${placeholders})`,
      now,
      now,
      ...OPEN_REQUEST_STATES
    ).rowsWritten
  }

  deleteFinishedBefore(cutoff: number): void {
    this.sql.exec("DELETE FROM requests WHERE finished_at IS NOT NULL AND finished_at <= ?", cutoff)
  }

  countOpen(): number {
    const placeholders = OPEN_REQUEST_STATES.map(() => "?").join(", ")
    return this.sql
      .exec<{ n: number }>(
        `SELECT count(*) AS n FROM requests WHERE state IN (${placeholders})`,
        ...OPEN_REQUEST_STATES
      )
      .one().n
  }

  countCreatedSince(since: number): number {
    return this.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM requests WHERE created_at > ?", since)
      .one().n
  }

  /** When the alarm must next run: the earliest expiry or cleanup, or null. */
  nextAlarmAt(): number | null {
    const placeholders = OPEN_REQUEST_STATES.map(() => "?").join(", ")
    const open = this.sql
      .exec<{ t: number | null }>(
        `SELECT min(expires_at) AS t FROM requests WHERE state IN (${placeholders})`,
        ...OPEN_REQUEST_STATES
      )
      .one().t
    const finished = this.sql
      .exec<{ t: number | null }>(
        "SELECT min(finished_at) AS t FROM requests WHERE finished_at IS NOT NULL"
      )
      .one().t
    const candidates = [
      open,
      finished === null ? null : finished + FINISHED_REQUEST_RETENTION_MS,
    ].filter((value): value is number => value !== null)
    return candidates.length ? Math.min(...candidates) : null
  }

  /** The last assigned serverSeq, 0 for an empty log. */
  lastServerSeq(): number {
    const rows = this.sql
      .exec<{ last: number | null }>("SELECT MAX(last_seq) AS last FROM ops")
      .toArray()
    return rows[0]?.last ?? 0
  }

  lastDeviceSeq(deviceId: string): number {
    const rows = this.sql
      .exec<{ last_seq: number }>("SELECT last_seq FROM device_seqs WHERE device_id = ?", deviceId)
      .toArray()
    return rows[0]?.last_seq ?? 0
  }

  /** Stores one push as one row and advances the device's sequence. Call inside a transaction. */
  appendOps(
    deviceId: string,
    ops: readonly unknown[],
    lastDeviceSeq: number,
    at: number
  ): { firstSeq: number; lastSeq: number; size: number } {
    const firstSeq = this.lastServerSeq() + 1
    const lastSeq = firstSeq + ops.length - 1
    const json = JSON.stringify(ops)
    this.sql.exec(
      "INSERT INTO ops (first_seq, last_seq, device_id, at, size, ops) VALUES (?, ?, ?, ?, ?, ?)",
      firstSeq,
      lastSeq,
      deviceId,
      at,
      json.length,
      json
    )
    this.sql.exec(
      "INSERT INTO device_seqs (device_id, last_seq) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seq = excluded.last_seq",
      deviceId,
      lastDeviceSeq
    )
    return { firstSeq, lastSeq, size: json.length }
  }

  /** Whole batches after `after`, up to about `maxBytes` (always at least one). */
  opsAfter(
    after: number,
    maxBytes: number,
    maxBatches: number
  ): { batches: OpBatch[]; more: boolean } {
    const rows = this.sql
      .exec<{ first_seq: number; last_seq: number; device_id: string; size: number; ops: string }>(
        "SELECT first_seq, last_seq, device_id, size, ops FROM ops WHERE last_seq > ? ORDER BY first_seq LIMIT ?",
        after,
        maxBatches + 1
      )
      .toArray()
    const batches: OpBatch[] = []
    let bytes = 0
    for (const row of rows.slice(0, maxBatches)) {
      if (batches.length > 0 && bytes + row.size > maxBytes) return { batches, more: true }
      bytes += row.size
      batches.push({
        firstSeq: row.first_seq,
        lastSeq: row.last_seq,
        deviceId: row.device_id,
        ops: JSON.parse(row.ops) as unknown[],
      })
    }
    return { batches, more: rows.length > maxBatches }
  }

  oplogBytes(): number {
    const rows = this.sql
      .exec<{ total: number | null }>("SELECT SUM(size) AS total FROM ops")
      .toArray()
    return rows[0]?.total ?? 0
  }

  recordAck(deviceId: string, ackSeq: number, at: number): void {
    this.sql.exec(
      "INSERT INTO acks (device_id, ack_seq, seen_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET ack_seq = MAX(acks.ack_seq, excluded.ack_seq), seen_at = excluded.seen_at",
      deviceId,
      ackSeq,
      at
    )
  }

  ack(deviceId: string): { ackSeq: number; seenAt: number } | null {
    const rows = this.sql
      .exec<{ ack_seq: number; seen_at: number }>(
        "SELECT ack_seq, seen_at FROM acks WHERE device_id = ?",
        deviceId
      )
      .toArray()
    return rows[0] ? { ackSeq: rows[0].ack_seq, seenAt: rows[0].seen_at } : null
  }

  issueTicket(ticket: string, deviceId: string, expiresAt: number, now: number): void {
    this.sql.exec("DELETE FROM tickets WHERE expires_at <= ?", now)
    this.sql.exec(
      "INSERT INTO tickets (ticket, device_id, expires_at) VALUES (?, ?, ?)",
      ticket,
      deviceId,
      expiresAt
    )
  }

  /** Consumes a ticket: the device it was issued to, or null if unknown or expired. */
  takeTicket(ticket: string, now: number): string | null {
    const rows = this.sql
      .exec<{ device_id: string; expires_at: number }>(
        "SELECT device_id, expires_at FROM tickets WHERE ticket = ?",
        ticket
      )
      .toArray()
    this.sql.exec("DELETE FROM tickets WHERE ticket = ? OR expires_at <= ?", ticket, now)
    const row = rows[0]
    return row && row.expires_at > now ? row.device_id : null
  }
}
