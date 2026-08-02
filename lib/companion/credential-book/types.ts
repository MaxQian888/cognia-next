/**
 * Multi-host companion credential book (ADR-0097).
 *
 * The single-`CompanionConfig` abstraction assumed exactly one desktop per
 * client: one `baseUrl`, one device JWT, one TLS pin, one cursor namespace.
 * Everything that needed per-host separation — sync cursors, outbound queues,
 * the mirrored Dexie tables — had to reconstruct it from whatever field
 * happened to be unique, and "switching hosts" degenerated into wiping the
 * other host's state.
 *
 * This module splits that one record along its real seams:
 *
 * - {@link CompanionHostRecord} — the **public** description of one host. Safe
 *   to enumerate, safe to render in Settings, safe to persist in plain storage.
 * - {@link CompanionHostCredential} — the **secret** half. Never leaves secure
 *   storage (browser Vault / iOS Keychain / Android Keystore) and is never part
 *   of a record listing.
 * - {@link CompanionCredentialBook} — the operations over both.
 *
 * Records are addressed by {@link CompanionHostKey} — `{hostId,
 * accountNamespace}`. Both halves are required: the same physical desktop can
 * be paired from two local accounts, and those pairings must never share a
 * device JWT, a cursor watermark, or a mirrored row.
 */
import type { RoomDescriptorV2 } from "@/lib/signaling/v2-crypto"

/**
 * Namespace for a pairing that predates — or precedes — any account context.
 *
 * The pre-book world had exactly one pairing and no account concept, and the
 * mobile pair screen can still complete before an account is activated. Those
 * pairings are filed here rather than dropped or guessed onto someone's
 * account; the first account activation adopts the bucket.
 */
export const DEFAULT_ACCOUNT_NAMESPACE = "__local__"

/** Address of exactly one pairing. */
export interface CompanionHostKey {
  /** Stable id of the host. Survives IP changes, re-pairs and label edits. */
  hostId: string
  /** Local account the pairing belongs to. */
  accountNamespace: string
}

/**
 * Where a host can be reached.
 *
 * `baseUrl` is the address the pairing was minted against and is always
 * present; the other two are refreshed from `companion_endpoints` and are how
 * a client paired on one channel learns about the other (ADR-0021).
 */
export interface CompanionHostEndpoints {
  baseUrl: string
  lanBaseUrl?: string
  tunnelBaseUrl?: string
}

export type CompanionConnectionStatus = "unknown" | "online" | "offline" | "revoked"

/**
 * Last-known reachability, with a monotonic generation.
 *
 * Connection probes are concurrent and racy: a slow "offline" from the LAN
 * prober can land after a fast "online" from the tunnel prober. The generation
 * makes the ordering explicit — an update carrying a stale generation is
 * rejected rather than applied, so the book never regresses to an older verdict.
 */
export interface CompanionConnectionState {
  status: CompanionConnectionStatus
  /** Monotonic per host. Incremented by every accepted update. */
  generation: number
  lastOkAt: number | null
  lastErrorAt: number | null
  lastError: string | null
}

export function initialConnectionState(): CompanionConnectionState {
  return {
    status: "unknown",
    generation: 0,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
  }
}

/** The public half of a pairing. Contains no secret material. */
export interface CompanionHostRecord {
  hostId: string
  accountNamespace: string
  /** User-facing name. Defaults to the host name reported at pair time. */
  label: string
  endpoints: CompanionHostEndpoints
  /**
   * SHA-256 of the host's TLS SubjectPublicKeyInfo, captured at pair time.
   * `null` only for pairings minted before TLS pinning shipped; the transport
   * refuses to talk to a peer whose presented certificate does not match.
   */
  tlsPin: string | null
  /**
   * Namespace for everything derived per host: sync cursors, outbound queue
   * rows, the runtime-target database. Derived once at record creation and
   * then **immutable** — a namespace that moved would orphan every cursor and
   * queued row filed under the old one.
   */
  cursorNamespace: string
  /** Device identity this host issued us at pair time. */
  deviceId: string
  /** Host semver captured at pair time. Diagnostics only. */
  serverVersion: string
  /** ADR-0021 signaling room id. Absent disables the WebRTC tier. */
  rendezvousId?: string
  /** Public, self-certifying signaling v2 room descriptor. */
  signalingRoomDescriptor?: RoomDescriptorV2
  connection: CompanionConnectionState
  createdAt: number
  updatedAt: number
}

/** The secret half. Secure storage only; never enumerated. */
export interface CompanionHostCredential {
  /** Long-lived JWT returned by `POST /api/v1/auth/pair`. */
  deviceJwt: string
  /** Mobile-role ECDSA private key for signaling v2. */
  signalingPrivateKeyJwk?: JsonWebKey
}

/** Fields a caller supplies when registering or updating a pairing. */
export type CompanionHostDraft = Omit<
  CompanionHostRecord,
  "cursorNamespace" | "connection" | "createdAt" | "updatedAt"
> & {
  connection?: CompanionConnectionState
}

/** Patch accepted by {@link CompanionCredentialBook.updateConnection}. */
export interface CompanionConnectionPatch {
  status: CompanionConnectionStatus
  lastOkAt?: number | null
  lastErrorAt?: number | null
  lastError?: string | null
}

/**
 * Derive the immutable per-host namespace.
 *
 * Both halves are encoded so neither an account id containing `:` nor a host
 * id containing `:` can produce two different pairings with the same
 * namespace.
 */
export function deriveCursorNamespace(key: CompanionHostKey): string {
  return `${encodeURIComponent(key.accountNamespace)}:${encodeURIComponent(key.hostId)}`
}

/** Storage key for one record. Same encoding rule as the namespace. */
export function hostRecordKey(key: CompanionHostKey): string {
  return deriveCursorNamespace(key)
}

export function sameHost(a: CompanionHostKey, b: CompanionHostKey): boolean {
  return a.hostId === b.hostId && a.accountNamespace === b.accountNamespace
}

export function hostKeyOf(record: CompanionHostRecord): CompanionHostKey {
  return { hostId: record.hostId, accountNamespace: record.accountNamespace }
}

/** Thrown when a generation-guarded update loses its race. */
export class StaleConnectionGenerationError extends Error {
  readonly expected: number
  readonly actual: number

  constructor(expected: number, actual: number) {
    super(
      `Connection update carried generation ${expected} but the book is at ${actual}; the update was rejected.`
    )
    this.name = "StaleConnectionGenerationError"
    this.expected = expected
    this.actual = actual
  }
}

/** The operations the rest of the app talks to. */
export interface CompanionCredentialBook {
  /** Every record, optionally narrowed to one account namespace. */
  list(accountNamespace?: string): Promise<CompanionHostRecord[]>
  get(key: CompanionHostKey): Promise<CompanionHostRecord | null>
  /** Register or update the public half. Never touches credentials. */
  upsert(draft: CompanionHostDraft): Promise<CompanionHostRecord>
  /** Forget a pairing: record, credential, and active pointer. */
  remove(key: CompanionHostKey): Promise<void>
  /** The pairing this account currently talks to. */
  getActive(accountNamespace: string): Promise<CompanionHostRecord | null>
  setActive(key: CompanionHostKey): Promise<void>
  loadCredential(key: CompanionHostKey): Promise<CompanionHostCredential | null>
  saveCredential(key: CompanionHostKey, credential: CompanionHostCredential): Promise<void>
  /**
   * Record a reachability verdict.
   *
   * `expectedGeneration` is the generation the caller observed when it started
   * probing. A mismatch throws {@link StaleConnectionGenerationError} and the
   * book is left untouched. Omit it to force the update.
   */
  updateConnection(
    key: CompanionHostKey,
    patch: CompanionConnectionPatch,
    expectedGeneration?: number
  ): Promise<CompanionHostRecord>
}
