"use client"

/**
 * Automatic crash-report submission (ADR-0102 / ADR-0135).
 *
 * The Settings switch "Submit crash reports automatically" was persisted on the
 * connection and read by nothing, so a user who turned it on got exactly the
 * behaviour of a user who had not. This is the reader.
 *
 * The rules, in order:
 *
 *   1. Only for a connection whose `autoSubmit` is on — a separate decision
 *      from "a service is configured", as ADR-0102 requires.
 *   2. Only for reports captured *after* the switch was turned on
 *      (`autoSubmitSince`). A backlog the user was keeping local stays local.
 *      A connection with the switch on but no timestamp (set while this was
 *      dormant) is stamped now and nothing is sent in that pass.
 *   3. Only reports still waiting on the user (`ACTIONABLE_INCIDENT_STATES`):
 *      one that already carries a receipt has been sent.
 *   4. With the default consent: the report and nothing optional.
 *   5. Deduplicated through a per-account ledger written *before* each send,
 *      so a crash during the upload itself cannot turn into a resend loop on
 *      every launch. A failure the service may get over (unreachable, intake
 *      paused) is retried on later passes up to `AUTO_SUBMIT_MAX_ATTEMPTS`; a
 *      refusal (bad credentials, a report that no longer exists) is not.
 *
 * The receipt is what the caller shows: `runAutoSubmit` returns each outcome
 * with its support code, and the receipt itself is persisted by the submission
 * path (the desktop's submissions sidecar, the mobile plugin's `markReceipt`),
 * so `/logs` lists the report as sent with its code on the next read.
 */

import {
  ACTIONABLE_INCIDENT_STATES,
  normalizeIncidentClientState,
  type IncidentClientState,
} from "./types"
import type { StoredDiagnosticConnection } from "./connection"
import {
  DEFAULT_SUBMISSION_CONSENT,
  type SubmittableIncident,
  type SubmitIncidentResult,
} from "./submit-incident"

const LEDGER_KEY_PREFIX = "cognia.diagnostic-service.auto-submit"

/** Attempts per report before automatic submission gives up on it. */
export const AUTO_SUBMIT_MAX_ATTEMPTS = 3

/** Ledger entries kept per account; the oldest attempts are dropped first. */
export const AUTO_SUBMIT_LEDGER_LIMIT = 200

/**
 * Failure codes worth another attempt on a later pass. Everything else is a
 * refusal that resending the same report cannot fix.
 */
export const RETRYABLE_AUTO_SUBMIT_CODES: ReadonlySet<string> = new Set([
  "network_unavailable",
  "ingest_disabled",
  "malformed_response",
  "submission_failed",
])

/** A listed report, as automatic submission sees it. */
export interface AutoSubmitIncident extends SubmittableIncident {
  capturedAt: string
  state: string
}

export interface AutoSubmitLedgerEntry {
  attempts: number
  lastAttemptAt: string
  /** Set once a send completed — the report is never sent again. */
  supportCode: string | null
  /** The last failure's code, or null while an attempt is in flight / succeeded. */
  errorCode: string | null
}

/** Keyed by `incidentLedgerKey`. */
export type AutoSubmitLedger = Record<string, AutoSubmitLedgerEntry>

export type AutoSubmitOutcome =
  | { kind: "submitted"; incident: AutoSubmitIncident; receipt: SubmitIncidentResult }
  | { kind: "failed"; incident: AutoSubmitIncident; errorCode: string; willRetry: boolean }

/** Storage seam, the same one `connection.ts` takes. */
export interface AutoSubmitStoreDeps {
  local?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

function ledgerKey(accountId: string): string {
  return `${LEDGER_KEY_PREFIX}.${accountId}`
}

function localStore(deps: AutoSubmitStoreDeps): AutoSubmitStoreDeps["local"] | null {
  if (deps.local) return deps.local
  if (typeof localStorage === "undefined") return null
  return localStorage
}

/** Runtime-qualified: a desktop stem and a mobile incident id share no namespace. */
export function incidentLedgerKey(incident: Pick<SubmittableIncident, "id" | "runtime">): string {
  return `${incident.runtime}:${incident.id}`
}

function isLedgerEntry(value: unknown): value is AutoSubmitLedgerEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.attempts === "number" &&
    typeof entry.lastAttemptAt === "string" &&
    (entry.supportCode === null || typeof entry.supportCode === "string") &&
    (entry.errorCode === null || typeof entry.errorCode === "string")
  )
}

/** Read the ledger; an unreadable blob is discarded rather than trusted. */
export function loadAutoSubmitLedger(
  accountId: string,
  deps: AutoSubmitStoreDeps = {}
): AutoSubmitLedger {
  const store = localStore(deps)
  if (!store) return {}
  const raw = store.getItem(ledgerKey(accountId))
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("unrecognized ledger shape")
    }
    const ledger: AutoSubmitLedger = {}
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isLedgerEntry(entry)) ledger[key] = entry
    }
    return ledger
  } catch {
    store.removeItem(ledgerKey(accountId))
    return {}
  }
}

/** Persist the ledger, keeping the newest `AUTO_SUBMIT_LEDGER_LIMIT` entries. */
export function saveAutoSubmitLedger(
  accountId: string,
  ledger: AutoSubmitLedger,
  deps: AutoSubmitStoreDeps = {}
): void {
  const entries = Object.entries(ledger)
    .sort(([, left], [, right]) => right.lastAttemptAt.localeCompare(left.lastAttemptAt))
    .slice(0, AUTO_SUBMIT_LEDGER_LIMIT)
  localStore(deps)?.setItem(ledgerKey(accountId), JSON.stringify(Object.fromEntries(entries)))
}

function isActionable(state: string): boolean {
  const normalized: IncidentClientState | null = normalizeIncidentClientState(state)
  return normalized !== null && ACTIONABLE_INCIDENT_STATES.includes(normalized)
}

/** Whether a ledger entry still allows another attempt. */
function ledgerAllows(entry: AutoSubmitLedgerEntry | undefined): boolean {
  if (!entry) return true
  if (entry.supportCode) return false
  if (entry.attempts >= AUTO_SUBMIT_MAX_ATTEMPTS) return false
  // `errorCode: null` without a support code is an attempt that never came
  // back — the app died mid-send. It counts as a retryable failure.
  return entry.errorCode === null || RETRYABLE_AUTO_SUBMIT_CODES.has(entry.errorCode)
}

/**
 * The reports this pass should send, oldest first so support codes are issued
 * in the order the crashes happened.
 */
export function selectAutoSubmitCandidates(input: {
  connection: Pick<StoredDiagnosticConnection, "autoSubmit" | "autoSubmitSince">
  incidents: readonly AutoSubmitIncident[]
  ledger: AutoSubmitLedger
}): AutoSubmitIncident[] {
  const { connection, incidents, ledger } = input
  if (!connection.autoSubmit || !connection.autoSubmitSince) return []
  const since = Date.parse(connection.autoSubmitSince)
  if (Number.isNaN(since)) return []
  return incidents
    .filter((incident) => {
      const capturedAt = Date.parse(incident.capturedAt)
      return (
        !Number.isNaN(capturedAt) &&
        capturedAt >= since &&
        isActionable(incident.state) &&
        ledgerAllows(ledger[incidentLedgerKey(incident)])
      )
    })
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
}

/** Errors reach us as codes; anything else becomes the generic one. */
export function autoSubmitErrorCode(cause: unknown): string {
  if (typeof cause === "string") return cause
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: unknown }).code
    if (typeof code === "string") return code
  }
  return "submission_failed"
}

export interface RunAutoSubmitInput {
  accountId: string
  connection: StoredDiagnosticConnection
  incidents: readonly AutoSubmitIncident[]
  /** Send one report with the given consent. */
  submit: (
    incident: AutoSubmitIncident,
    consent: typeof DEFAULT_SUBMISSION_CONSENT
  ) => Promise<SubmitIncidentResult>
  /**
   * Persist a connection change — used once, to stamp `autoSubmitSince` on a
   * connection whose switch was turned on before this existed.
   */
  saveConnection: (connection: StoredDiagnosticConnection) => void
  now?: () => Date
  store?: AutoSubmitStoreDeps
}

/**
 * One pass over the listed reports. Never rejects: every failure is recorded
 * against its report and returned as an outcome.
 */
export async function runAutoSubmit(input: RunAutoSubmitInput): Promise<AutoSubmitOutcome[]> {
  const { accountId, connection, incidents, submit, saveConnection, store = {} } = input
  const now = input.now ?? (() => new Date())
  if (!connection.autoSubmit) return []
  if (!connection.autoSubmitSince) {
    // Turned on while this was dormant: from now on, not retroactively.
    saveConnection({ ...connection, autoSubmitSince: now().toISOString() })
    return []
  }

  const ledger = loadAutoSubmitLedger(accountId, store)
  const candidates = selectAutoSubmitCandidates({ connection, incidents, ledger })
  const outcomes: AutoSubmitOutcome[] = []

  for (const incident of candidates) {
    const key = incidentLedgerKey(incident)
    const previous = ledger[key]
    // Record the attempt before sending: a crash mid-upload must count.
    ledger[key] = {
      attempts: (previous?.attempts ?? 0) + 1,
      lastAttemptAt: now().toISOString(),
      supportCode: null,
      errorCode: null,
    }
    saveAutoSubmitLedger(accountId, ledger, store)
    try {
      const receipt = await submit(incident, DEFAULT_SUBMISSION_CONSENT)
      ledger[key] = { ...ledger[key], supportCode: receipt.supportCode, errorCode: null }
      outcomes.push({ kind: "submitted", incident, receipt })
    } catch (cause) {
      const errorCode = autoSubmitErrorCode(cause)
      ledger[key] = { ...ledger[key], errorCode }
      outcomes.push({
        kind: "failed",
        incident,
        errorCode,
        willRetry: ledgerAllows(ledger[key]),
      })
    }
    saveAutoSubmitLedger(accountId, ledger, store)
  }
  return outcomes
}

/**
 * Collapse concurrent passes for one account onto one run.
 *
 * Two mounts of the runner (a StrictMode double effect, a reload racing the
 * old window's teardown) would otherwise both read the ledger before either
 * wrote it and send the same report twice.
 */
const inFlight = new Map<string, Promise<AutoSubmitOutcome[]>>()

export function runAutoSubmitOnce(input: RunAutoSubmitInput): Promise<AutoSubmitOutcome[]> {
  const existing = inFlight.get(input.accountId)
  if (existing) return existing
  const run = runAutoSubmit(input).finally(() => {
    inFlight.delete(input.accountId)
  })
  inFlight.set(input.accountId, run)
  return run
}
