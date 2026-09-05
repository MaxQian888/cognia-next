"use client"

/**
 * The pairing failure taxonomy: one caught `unknown` in, one thing the user can
 * actually do out.
 *
 * # Why this exists
 *
 * `/pair` had all the raw material for good errors and used none of it.
 * `pair-helpers.ts` classified network failures into six kinds; `mobile.pair`
 * carried twelve written-out remedies under `networkError.*` and `httpError.*`;
 * `CompanionApiError` carried the status and the Host's own refusal code. Not
 * one of them had a caller. The step component rendered `error.message`, so a
 * browser that refused a self-signed LAN certificate produced the entire
 * user-facing text "Pairing failed / Failed to fetch", and a Host that had
 * *already registered the device* produced "the credential couldn't be saved
 * securely. Pair again" — advice that burns another one-shot invitation and
 * cannot work.
 *
 * This module is the missing middle. It takes the stage the flow reached, the
 * error it caught, and what the probe learned about the peer, and returns a
 * {@link PairFailure}: a kind, the technical detail (kept, never the headline),
 * and an ordered list of remedies naming *this* Host and *this* origin.
 *
 * # Why a browser needs its own taxonomy
 *
 * Cross-origin `fetch` deliberately collapses "no `Access-Control-Allow-Origin`",
 * "untrusted certificate" and "nothing is listening" into one indistinguishable
 * `TypeError`. The status code, headers and socket error are all withheld. So
 * the classification cannot come from the exception alone — it needs the
 * `no-cors` reachability bit from `lib/connectivity/origin-reachability.ts` and
 * the shape of the invitation's own base URL. That is why callers pass a
 * {@link PairFailureContext} rather than just an error.
 */

import { CompanionApiError } from "@/lib/tauri/companion-auth"
import { BrowserVaultLockedError } from "@/lib/companion/credential-book"
import { companionPairPhaseOf } from "@/lib/companion/host-orchestration"
import { isBrowserTrustableOrigin } from "@/lib/connectivity/origin-reachability"
import { DEFAULT_BROWSER_ACCESS_PORT } from "@/lib/connectivity/loopback-discovery"

import { classifyPairNetworkError, validateWebPairingTransport } from "./pair-helpers"

/** How far the flow got before it failed. */
export type PairFailureStage =
  /** Decoding the pasted/scanned `cgnp3` string. */
  | "decode"
  /** Pre-flight checks on the invitation's transport, before any request. */
  | "transport"
  /** Talking to the Host: auth config, challenge, device registration. */
  | "register"
  /** Writing the device key into this client's secure storage. */
  | "persist"
  /** Bringing the freshly paired Host online (manifest, sync, bindings). */
  | "activate"

export type PairFailureKind =
  | "payload_wrong_format"
  | "payload_version"
  | "payload_expired"
  | "payload_invalid"
  | "insecure_transport"
  | "offline"
  | "origin_blocked"
  | "tls_untrusted"
  | "unreachable"
  | "http"
  | "vault_locked"
  | "persist_failed"
  | "activate_failed"
  /**
   * The Host answered with a signing key other than the one the invitation
   * link pinned. The pairing itself succeeded on the Host side, so the
   * invitation is spent, but this client refuses to persist a key it was
   * told not to trust.
   */
  | "fingerprint_mismatch"
  | "scan_failed"
  | "clipboard_unavailable"
  | "unknown"

/**
 * A remedy id, resolved against `mobile.pair.failure.remedy.<id>`.
 *
 * Ids rather than strings so the taxonomy stays a pure function and the copy
 * stays in the message catalogue where `lint:i18n` can see it.
 */
export type PairRemedy =
  | "enableBrowserAccess"
  | "allowlistOrigin"
  | "useLoopbackInvitation"
  | "checkHostRunning"
  | "sameNetwork"
  | "freshInvitation"
  | "unlockAccount"
  | "updateHost"
  | "checkHostLogs"
  | "removeStaleDevice"
  | "reloadAndRetry"

export interface PairFailure {
  stage: PairFailureStage
  kind: PairFailureKind
  /** Raw technical text. Always preserved; shown under "technical detail". */
  detail: string
  /**
   * A ready-made explanation that replaces the kind's catalogue message.
   *
   * For failures the caller has already put into words — a camera refusal, a
   * clipboard the browser would not read — where routing the sentence through
   * a network taxonomy would only make it vaguer.
   */
  bodyText?: string
  /** HTTP status, when the Host actually answered with one. */
  status?: number
  /** The Host's own refusal code (e.g. `web_origin_forbidden`). */
  code?: string
  /** `cgnp<n>` version the Host issued, for the version-mismatch kind. */
  payloadVersion?: number
  /** Ordered, most-likely-first. */
  remedies: PairRemedy[]
  /**
   * Whether submitting the *same* invitation again could work. One-shot
   * invitations mean this is false far more often than a generic "Retry"
   * button implies.
   */
  retryable: boolean
  /**
   * The Host already consumed the invitation and registered this device. The UI
   * must not suggest "pair again" without also saying to issue a fresh one.
   */
  invitationSpent: boolean
  /** Host base URL from the invitation, for remedies that name it. */
  baseUrl?: string
  /** This tab's origin — the exact string to allowlist on the Host. */
  origin?: string
  /** Loopback browser-access URL to suggest instead of an untrusted LAN one. */
  loopbackUrl?: string
  /** Fingerprint the pair link pinned (`fingerprint_mismatch` only). */
  expectedFingerprint?: string
  /** Fingerprint the Host actually presented (`fingerprint_mismatch` only). */
  reportedFingerprint?: string
}

export interface PairFailureContext {
  stage: PairFailureStage
  /** Host base URL from the decoded invitation, when there is one. */
  baseUrl?: string
  /** True when running as a plain browser rather than the Capacitor shell. */
  webMode?: boolean
  /**
   * Result of the `no-cors` reachability probe against {@link baseUrl}, when
   * the caller ran one. `true` = something answered (so a refusal is policy),
   * `false` = nothing completed, `undefined` = not probed.
   */
  peerAnswered?: boolean
  /** Defaults to `navigator.onLine`. */
  online?: boolean
  /** Defaults to `window.location.origin`. */
  origin?: string
}

/**
 * Fingerprints as they appear in QR payloads, deep links and `serverFingerprint`
 * (hex with or without colons, any case) compared as bytes, not text.
 */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-f]/gi, "").toLowerCase()
}

/**
 * The Host presented a different signing key than the one the pair link
 * pinned. Built after `registerPairPayload` succeeded, so the invitation is
 * spent and only a fresh one helps; the client must not persist the config.
 */
export function fingerprintMismatchFailure(input: {
  baseUrl?: string
  expectedFingerprint: string
  reportedFingerprint: string
}): PairFailure {
  return {
    stage: "register",
    kind: "fingerprint_mismatch",
    detail: `expected ${input.expectedFingerprint}, got ${input.reportedFingerprint}`,
    baseUrl: input.baseUrl,
    expectedFingerprint: input.expectedFingerprint,
    reportedFingerprint: input.reportedFingerprint,
    remedies: ["freshInvitation", "checkHostLogs"],
    retryable: false,
    invitationSpent: true,
  }
}

/** Classify one caught pairing error into something the UI can act on. */
export function diagnosePairFailure(error: unknown, context: PairFailureContext): PairFailure {
  const base = {
    stage: context.stage,
    detail: messageOf(error),
    baseUrl: context.baseUrl,
    origin: context.origin ?? currentOrigin(),
    loopbackUrl: `http://127.0.0.1:${DEFAULT_BROWSER_ACCESS_PORT}`,
  }

  if (error instanceof BrowserVaultLockedError) {
    return {
      ...base,
      kind: "vault_locked",
      // The Host registered the device before this client tried to store the
      // key, so the invitation is gone either way.
      invitationSpent: true,
      retryable: false,
      remedies: ["unlockAccount", "freshInvitation", "removeStaleDevice"],
    }
  }

  if (context.stage === "persist" || context.stage === "activate") {
    const phase = companionPairPhaseOf(error)
    const activationFailed = phase === "activate" || context.stage === "activate"
    return {
      ...base,
      kind: activationFailed ? "activate_failed" : "persist_failed",
      invitationSpent: true,
      // Activation is retryable without a new invitation — the credential is
      // already stored, so reconnecting is a local operation.
      retryable: activationFailed,
      remedies: activationFailed
        ? ["reloadAndRetry", "checkHostRunning", "checkHostLogs"]
        : ["unlockAccount", "freshInvitation", "removeStaleDevice"],
    }
  }

  if (error instanceof CompanionApiError) {
    return {
      ...base,
      kind: "http",
      status: error.status,
      code: error.code || undefined,
      invitationSpent:
        error.status === 401 ||
        error.status === 409 ||
        isSpentInvitationCode(error.code || undefined),
      retryable: error.status >= 500,
      remedies: httpRemedies(error.status, error.code),
    }
  }

  const network = classifyPairNetworkError(error, context.online)
  if (network === "offline") {
    return {
      ...base,
      kind: "offline",
      invitationSpent: false,
      retryable: true,
      remedies: ["sameNetwork", "freshInvitation"],
    }
  }
  if (network === "certificate") {
    return {
      ...base,
      kind: "tls_untrusted",
      invitationSpent: false,
      retryable: false,
      remedies: certificateRemedies(context),
    }
  }
  if (network === "browser_policy") {
    return {
      ...base,
      kind: "origin_blocked",
      invitationSpent: false,
      retryable: false,
      remedies: ["enableBrowserAccess", "allowlistOrigin", "freshInvitation"],
    }
  }

  // `browser_blocked` is the opaque `Failed to fetch`. The probe is the only
  // thing that can split it, so resolve it here rather than guessing.
  if (network === "browser_blocked") {
    if (context.peerAnswered === true) {
      return {
        ...base,
        kind: "origin_blocked",
        invitationSpent: false,
        retryable: false,
        remedies: ["enableBrowserAccess", "allowlistOrigin", "freshInvitation"],
      }
    }
    if (context.peerAnswered === false && !browserCanTrust(context)) {
      return {
        ...base,
        kind: "tls_untrusted",
        invitationSpent: false,
        retryable: false,
        remedies: certificateRemedies(context),
      }
    }
    return {
      ...base,
      kind: "unreachable",
      invitationSpent: false,
      retryable: true,
      remedies: ["checkHostRunning", "sameNetwork", "enableBrowserAccess"],
    }
  }
  if (network === "unreachable") {
    return {
      ...base,
      kind: "unreachable",
      invitationSpent: false,
      retryable: true,
      remedies: ["checkHostRunning", "sameNetwork"],
    }
  }

  return {
    ...base,
    kind: "unknown",
    invitationSpent: false,
    retryable: true,
    remedies: ["checkHostRunning", "freshInvitation", "checkHostLogs"],
  }
}

/** Failures that are known before a single request goes out. */
export function diagnosePayloadFailure(
  outcome:
    | { kind: "wrong_format" }
    | { kind: "version_mismatch"; got: number }
    | { kind: "invalid"; message: string }
): PairFailure {
  if (outcome.kind === "version_mismatch") {
    return {
      stage: "decode",
      kind: "payload_version",
      detail: `cgnp${outcome.got}`,
      payloadVersion: outcome.got,
      invitationSpent: false,
      retryable: false,
      remedies: ["updateHost", "freshInvitation"],
    }
  }
  if (outcome.kind === "invalid" && /expired/i.test(outcome.message)) {
    return {
      stage: "decode",
      kind: "payload_expired",
      detail: outcome.message,
      invitationSpent: true,
      retryable: false,
      remedies: ["freshInvitation"],
    }
  }
  return {
    stage: "decode",
    kind: outcome.kind === "wrong_format" ? "payload_wrong_format" : "payload_invalid",
    detail: outcome.kind === "invalid" ? outcome.message : "not a cgnp3 invitation",
    invitationSpent: false,
    retryable: false,
    remedies: ["freshInvitation"],
  }
}

/**
 * The transport pre-check, run before the first request.
 *
 * Deliberately narrow: it refuses only what is unambiguously wrong — a
 * `http://` invitation aimed off-machine, which would put the device key on the
 * wire in cleartext, and which the Host's own origin policy
 * (`web_origin::is_secure_or_loopback`) refuses from the other side too.
 *
 * It does **not** pre-refuse an `https://` LAN address even though a browser
 * almost certainly cannot verify its self-signed certificate. "Almost
 * certainly" is not good enough to spend a user's only invitation on: they may
 * have installed the CA, or be on a Host with a real certificate and an odd
 * name. So that case is attempted, and if it fails, `diagnosePairFailure` names
 * it exactly — with the probe result to back the claim up rather than a guess.
 */
export function diagnoseTransport(baseUrl: string, webMode: boolean): PairFailure | null {
  if (validateWebPairingTransport(baseUrl, webMode) !== "https_required") return null
  return {
    stage: "transport",
    kind: "insecure_transport",
    detail: `${baseUrl} is plaintext and not loopback`,
    baseUrl,
    origin: currentOrigin(),
    loopbackUrl: `http://127.0.0.1:${DEFAULT_BROWSER_ACCESS_PORT}`,
    invitationSpent: false,
    retryable: false,
    remedies: ["enableBrowserAccess", "useLoopbackInvitation"],
  }
}

function certificateRemedies(context: PairFailureContext): PairRemedy[] {
  return context.webMode
    ? ["enableBrowserAccess", "useLoopbackInvitation", "freshInvitation"]
    : ["checkHostRunning", "freshInvitation"]
}

function browserCanTrust(context: PairFailureContext): boolean {
  if (!context.webMode || !context.baseUrl) return true
  return isBrowserTrustableOrigin(context.baseUrl)
}

/**
 * Host refusal codes that mean *this invitation is gone* — expired, already
 * redeemed, or never supplied. The string is the only thing that separates them
 * from an allow-list refusal, because both arrive as a bare 403.
 */
const SPENT_INVITATION_CODES = new Set([
  "invalid_owner_invitation",
  "owner_invitation_required",
  "worker_enrollment_required",
  "browser_enrollment_required",
])

/** Host refusal codes that mean the *caller's origin* was refused. */
const ORIGIN_REFUSAL_CODES = new Set([
  "web_origin_forbidden",
  "private_network_access_forbidden",
  "device_origin_mismatch",
])

/**
 * Host refusal codes about *which account or tenant* is asking. A fresh
 * invitation from the same account reproduces them exactly; the stale device
 * record or the host binding has to go first.
 */
const IDENTITY_REFUSAL_CODES = new Set(["host_binding_mismatch", "tenant_mismatch"])

/**
 * True when a 403 says the invitation itself is used up.
 *
 * Read by the caller so the panel's "this invitation is now spent" line comes
 * from the Host's own verdict rather than from a status-code guess. Only 401
 * and 409 used to set it, so a re-submitted `cgnp3` — the single most common
 * way to reach this code — was reported as still reusable.
 */
export function isSpentInvitationCode(code: string | undefined): boolean {
  return code !== undefined && SPENT_INVITATION_CODES.has(code)
}

/**
 * Order the remedies for an HTTP refusal.
 *
 * 403 is four unrelated verdicts wearing one status: the origin was refused,
 * the invitation is used up, the account/tenant does not match, or the Host is
 * in a state that forbids the call. Collapsing them into one bucket is how a
 * re-submitted invitation came back as "turn on browser access" — advice for a
 * listener the request had demonstrably just travelled through. The Host always
 * sends a `code`; route on it, and only fall back to the bucket when it is
 * absent.
 */
function httpRemedies(status: number, code: string): PairRemedy[] {
  if (ORIGIN_REFUSAL_CODES.has(code)) {
    return ["enableBrowserAccess", "allowlistOrigin", "freshInvitation"]
  }
  if (SPENT_INVITATION_CODES.has(code)) return ["freshInvitation", "removeStaleDevice"]
  if (IDENTITY_REFUSAL_CODES.has(code)) return ["removeStaleDevice", "checkHostLogs"]
  if (status === 401 || status === 409) return ["freshInvitation", "removeStaleDevice"]
  // A code-less 403 really is ambiguous — keep the historical ordering.
  if (status === 403) return ["enableBrowserAccess", "allowlistOrigin", "freshInvitation"]
  if (status === 404) return ["updateHost", "checkHostRunning"]
  if (status >= 500) return ["checkHostLogs", "freshInvitation"]
  return ["freshInvitation", "checkHostLogs"]
}

/** The `mobile.pair.*` key holding this failure's explanation. */
export function pairFailureBodyKey(failure: PairFailure): string {
  switch (failure.kind) {
    case "payload_wrong_format":
    case "payload_invalid":
      return "payloadError.invalid"
    case "payload_version":
      return "payloadError.versionMismatch"
    case "payload_expired":
      return "failure.body.expired"
    case "insecure_transport":
      return "web.httpsRequired"
    case "offline":
      return "networkError.offline"
    case "origin_blocked":
      return "networkError.browserPolicy"
    case "tls_untrusted":
      return "networkError.certificate"
    case "unreachable":
      return "networkError.unreachable"
    case "http":
      return httpBodyKey(failure.status, failure.code)
    case "vault_locked":
      return "failure.body.vaultLocked"
    case "persist_failed":
      return "persistenceError"
    case "fingerprint_mismatch":
      return "fingerprintMismatch"
    case "activate_failed":
      return "failure.body.activateFailed"
    case "scan_failed":
    case "clipboard_unavailable":
      // Only reached when the caller supplied no bodyText; the raw detail is
      // the most specific thing left to say.
      return "networkError.unknown"
    default:
      return "networkError.unknown"
  }
}

function httpBodyKey(status: number | undefined, code?: string): string {
  if (status === 401) return "httpError.401"
  if (status === 403) {
    // The generic 403 sentence sends the reader to the allow-list. That is the
    // wrong place for two of the four things a 403 means here, and the Host
    // already said which one it is.
    if (isSpentInvitationCode(code)) return "httpError.403Spent"
    if (code !== undefined && IDENTITY_REFUSAL_CODES.has(code)) return "httpError.403Identity"
    return "httpError.403"
  }
  if (status === 404) return "httpError.404"
  if (status !== undefined && status >= 500) return "httpError.5xx"
  return "httpError.generic"
}

/** Copy-paste block for a bug report — everything, nothing secret. */
export function formatPairDiagnostics(failure: PairFailure): string {
  const lines = [
    `stage: ${failure.stage}`,
    `kind: ${failure.kind}`,
    failure.status !== undefined ? `status: ${failure.status}` : null,
    failure.code ? `code: ${failure.code}` : null,
    failure.baseUrl ? `host: ${failure.baseUrl}` : null,
    failure.origin ? `origin: ${failure.origin}` : null,
    `invitationSpent: ${failure.invitationSpent}`,
    `detail: ${failure.detail}`,
  ]
  return lines.filter((line): line is string => line !== null).join("\n")
}

/**
 * The full text of a caught error — headline *and* the causes underneath it.
 *
 * A plain `error.message` is a lie for the two error shapes this flow actually
 * produces. `AggregateError` puts its constituents in `.errors` and gives the
 * wrapper a summary sentence of its own, so activation's
 * "Companion Host activation failed and rollback was incomplete." rendered as
 * the *entire* technical detail while the two errors that say what went wrong
 * — a 403 from the Host, a target that could not be restored — were dropped on
 * the floor. `CompanionPairPhaseError` and anything constructed with
 * `{ cause }` hide theirs one level down the same way.
 *
 * The detail line is the only place a user can read the real failure, so it
 * flattens both: breadth through `AggregateError.errors`, depth through
 * `cause`. Visited-set and caps keep a self-referential `cause` from spinning
 * and a fan-out from filling the panel.
 */
function messageOf(error: unknown): string {
  const parts = flattenErrorText(error, new Set())
  // `CompanionPairPhaseError` copies its reason's message and *also* keeps it
  // as `cause`, and an `AggregateError` whose members share a cause repeats it
  // per member. Both are the same sentence twice on screen; drop the repeats
  // rather than the structure that produces them.
  return parts.filter((part, index) => parts.indexOf(part) === index).join(" ← ")
}

/** Depth of `cause` links followed. Beyond this the chain is noise, not detail. */
const MAX_CAUSE_DEPTH = 4
/** Constituents rendered from one `AggregateError`. */
const MAX_AGGREGATE_ERRORS = 4

function flattenErrorText(error: unknown, seen: Set<unknown>, depth = 0): string[] {
  if (depth > MAX_CAUSE_DEPTH) return []
  // `cause` is absent on most errors; `String(undefined)` would otherwise put
  // the literal text "undefined" at the end of every detail line.
  if (error === undefined || error === null) return []
  if (typeof error === "object") {
    if (seen.has(error)) return []
    seen.add(error)
  }
  if (!(error instanceof Error)) {
    const text = String(error)
    return text ? [text] : []
  }

  const parts: string[] = []
  if (error.message) parts.push(error.message)

  // `AggregateError.errors` first: its members are siblings of the headline,
  // not a deeper cause, and they are the ones that name the real failure.
  const members = error instanceof AggregateError ? error.errors : []
  if (Array.isArray(members) && members.length > 0) {
    const shown = members.slice(0, MAX_AGGREGATE_ERRORS)
    const rendered = shown
      .map((member) => flattenErrorText(member, seen, depth + 1).join(" ← "))
      .filter((text) => text.length > 0)
    // Activation and its rollback routinely fail at the same leg for the same
    // reason, which printed one sentence twice. Identical members carry no
    // extra information; number them only when they actually differ.
    const distinct = rendered.filter((text, index) => rendered.indexOf(text) === index)
    if (distinct.length === 1) parts.push(distinct[0])
    else if (distinct.length > 1) {
      parts.push(distinct.map((text, index) => `[${index + 1}] ${text}`).join(" "))
    }
    if (members.length > shown.length) {
      parts.push(`(+${members.length - shown.length} more)`)
    }
  }

  parts.push(...flattenErrorText(error.cause, seen, depth + 1))
  return parts.filter((part) => part.length > 0)
}

function currentOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined
  return window.location.origin
}
