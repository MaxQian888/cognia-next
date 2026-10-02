/**
 * Runtime-neutral probe types.
 *
 * Everything under `src/core/` is bundled twice: into the Node runner here
 * and into the Cloudflare status Worker (owner B), which supplies its own
 * `ProbeTransport` built on `fetch` + `Upgrade: websocket`. So this layer uses
 * only WebCrypto, `TextEncoder`, `AbortSignal`, `setTimeout` and `URL`: no
 * Node built-ins, no `Buffer`, no DOM-only types.
 */

import type { CheckObservation, ProfileId, ReasonCode } from "../../../../../lib/status/contract"

export interface ProbeLimits {
  /** `GET /healthz` budget (plan §4: 6 s). */
  httpTimeoutMs: number
  /** Whole authenticated signal + data run (plan §4: at most 20 s). */
  protocolDeadlineMs: number
  /** Budget for any single protocol phase (connect, subscribe, relay...). */
  phaseTimeoutMs: number
  /** How long cleanup waits for both sockets to finish closing. */
  closeDeadlineMs: number
  /** Random bytes in the data-lane payload, before base64url (≈1 KiB). */
  dataPayloadBytes: number
}

export const DEFAULT_PROBE_LIMITS: Readonly<ProbeLimits> = Object.freeze({
  httpTimeoutMs: 6_000,
  protocolDeadlineMs: 20_000,
  phaseTimeoutMs: 6_000,
  closeDeadlineMs: 2_000,
  dataPayloadBytes: 1_024,
})

/**
 * Per-room relay traffic ceiling (plan §4.4: below 1 MiB). The relay meters
 * data-lane bytes per delivered copy and persists its quota only past 1 MiB,
 * so staying under it keeps a fresh probe room from ever writing quota state.
 */
export const MAX_ROOM_RELAY_BYTES = 1024 * 1024

/**
 * The relay's data-lane frame cap is 64 KiB (`DATA_MAX_FRAME_BYTES`); the
 * base64url payload plus envelope must stay well inside it.
 */
export const MAX_DATA_PAYLOAD_BYTES = 32 * 1024
export const MIN_DATA_PAYLOAD_BYTES = 16

/**
 * One open WebSocket, text frames only (the signaling relay sends JSON text).
 *
 * Adapter contract:
 * - Frames that arrive before anyone calls `next()` must be buffered in
 *   order, so no frame is lost between phases.
 * - `next(timeoutMs)` resolves with the next buffered or arriving text frame.
 *   It rejects with `ProbeTransportError("timeout")` when nothing arrives in
 *   time, and with `ProbeTransportError("ws_closed")` once the socket has
 *   closed and the buffer is empty. A timed-out call must not swallow a frame
 *   that arrives later.
 * - `close()` is idempotent and never throws; `closed` resolves (never
 *   rejects) once the socket is fully closed.
 */
export interface ProbeSocket {
  send(text: string): void
  /** Next text frame; rejects on close/abort/timeout. */
  next(timeoutMs: number): Promise<string>
  close(): void
  readonly closed: Promise<void>
}

export type HttpProbeResponse = {
  status: number
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  body: unknown
  /** True when a body was present but was not valid JSON. */
  parseError: boolean
}

/**
 * Network access for one run. Implementations classify their own failures
 * into `ProbeTransportError` reasons: `timeout`, `dns_error`, `tls_error`,
 * `connect_error`, or `ws_upgrade` with the HTTP status of a refused upgrade.
 * An aborted `signal` must reject promptly (any error is fine; the core
 * checks `signal.aborted` first).
 */
export interface ProbeTransport {
  getJson(url: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<HttpProbeResponse>
  openSocket(
    url: string,
    opts: { origin: string | null; timeoutMs: number; signal: AbortSignal }
  ): Promise<ProbeSocket>
}

/** A classified network failure raised by a transport adapter. */
export class ProbeTransportError extends Error {
  constructor(
    readonly reason: ReasonCode,
    message?: string,
    readonly httpStatus?: number
  ) {
    super(message ?? reason)
    this.name = "ProbeTransportError"
  }
}

export interface ProbeRunResult {
  startedAtMs: number
  finishedAtMs: number
  checks: CheckObservation[]
  /** The run was cancelled by its abort signal; callers should not submit it. */
  aborted?: boolean
  /** Relay payload bytes this run sent through its room (both directions). */
  relayBytesSent?: number
}

export interface ProbeProfileInput {
  id: ProfileId
  /** Exact Origin header to send, or null for the originless native client. */
  origin: string | null
}

export interface RunProbeChecksInput {
  signalingUrl: string
  profile: ProbeProfileInput
  runHttp: boolean
  runProtocol: boolean
  transport: ProbeTransport
  now?: () => number
  signal?: AbortSignal
  limits?: Partial<ProbeLimits>
}

/** Validate and complete caller limits; throws on a nonsensical budget. */
export function resolveLimits(partial: Partial<ProbeLimits> | undefined): ProbeLimits {
  const limits: ProbeLimits = { ...DEFAULT_PROBE_LIMITS, ...(partial ?? {}) }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid probe limit ${key}`)
  }
  if (
    !Number.isInteger(limits.dataPayloadBytes) ||
    limits.dataPayloadBytes < MIN_DATA_PAYLOAD_BYTES ||
    limits.dataPayloadBytes > MAX_DATA_PAYLOAD_BYTES
  ) {
    throw new Error("invalid probe limit dataPayloadBytes")
  }
  return limits
}
