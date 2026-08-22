/**
 * Matrix `/sync` long-poll transport.
 *
 * Drives the client-server `/sync` loop via the Tauri HTTP proxy, threading
 * the `next_batch` cursor so each poll only returns events since the last.
 * On a first-ever start (no persisted cursor) the priming sync only
 * establishes the cursor — its timeline is discarded so the adapter does not
 * replay room history. When the caller passes a persisted `initialSince`
 * cursor (survived a restart), the FIRST batch is real downtime traffic and
 * is delivered, not discarded. Every accepted `next_batch` is reported via
 * `onNextBatch` so the caller can persist it.
 *
 * Also handles:
 * - room invites → auto-join (once per room, so a failing join cannot loop),
 * - `limited: true` timelines → gap backfill via `/messages` (dir=b, capped),
 * - `M_UNKNOWN_TOKEN` / `soft_logout` → throws {@link MatrixSyncAuthError}
 *   and stops (retrying a dead token forever would mask the auth failure),
 * - 429 → honors `retry_after_ms`,
 * - other 5xx / network errors → exponential backoff with reset on success,
 *   matching the Telegram long-poll transport.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import { normalizeHomeserver } from "./auth"
import type { MatrixSyncResponse, MatrixTimelineEvent } from "./parse"

const CLIENT_V3 = "/_matrix/client/v3"
const DEFAULT_TIMEOUT_MS = 30_000
/** Max `/messages` pages fetched per limited-timeline gap. */
const BACKFILL_PAGE_CAP = 3
const BACKFILL_PAGE_LIMIT = 50

/**
 * The homeserver rejected our access token (`M_UNKNOWN_TOKEN`, including
 * `soft_logout`). Thrown out of the generator so the adapter can flip health
 * to degraded/auth_failed instead of retrying a dead token forever.
 *
 * Recovery: one `refresh_token` exchange is attempted before the loop gives
 * up, so an expiring access token no longer costs the device (and its E2EE
 * keys). Only a rejected refresh token — or a bot configured with a bare
 * pasted access token — is terminal.
 */
export class MatrixSyncAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MatrixSyncAuthError"
  }
}

export interface MatrixSyncOptions {
  homeserver: string
  accessToken: () => Promise<string>
  signal: AbortSignal
  /**
   * Persisted `next_batch` cursor from a previous run. When present the
   * first sync uses it as `since` and its batch IS delivered (downtime
   * catch-up); when absent the priming batch is discarded.
   */
  initialSince?: string
  /** Called with every accepted `next_batch` so the caller can persist it. */
  onNextBatch?: (token: string) => void
  /** Process crypto/state changes before any timeline event from the batch. */
  onSyncResponse?: (body: MatrixSyncResponse, hasGap: boolean) => Promise<void>
  /** Fail-closed cursor gate used when the encrypted-event recovery queue is full. */
  canAdvanceCursor?: () => boolean
  /**
   * Exchange the stored refresh token for a fresh access token.
   *
   * Supplied by the adapter; absent in tests and for bots configured with a
   * bare pasted token. When it is absent, or reports `needsReauth`, an expired
   * token is terminal exactly as before.
   */
  refreshAccessToken?: () => Promise<
    { ok: true; accessToken: string } | { ok: false; needsReauth: boolean; error: string }
  >
  /** Sink for non-fatal transport warnings (failed invite joins, backfill). */
  logger?: { warn: (msg: string, fields?: Record<string, unknown>) => void }
  /** Long-poll timeout sent to the homeserver (ms). Default: 30000. */
  timeoutMs?: number
  /** Override backoff base ms for testing. Default: 1000. */
  _backoffBaseMs?: number
}

export interface MatrixRoomEvent {
  roomId: string
  event: MatrixTimelineEvent
}

/** Delay `ms`; rejects if `signal` fires first. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const tid = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(tid)
      reject(new DOMException("Aborted", "AbortError"))
    })
  })
}

/** Stop awaiting a non-cancellable Tauri request as soon as the adapter stops. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Inline sync filter: lazy-load member state (the priming full-state sync on
 * a large account is otherwise enormous) and cap each room timeline. The
 * priming call uses `limit: 1` — its timeline is discarded anyway, so there
 * is no point transferring recent history.
 */
function syncFilter(primed: boolean): string {
  return JSON.stringify({
    room: {
      state: { lazy_load_members: true },
      timeline: { limit: primed ? 20 : 1 },
    },
  })
}

interface MatrixMessagesResponse {
  chunk?: MatrixTimelineEvent[]
  end?: string
}

/**
 * Backfill a `limited: true` timeline gap: walk `/messages` backwards from
 * the batch's `prev_batch` until we meet the last event we already delivered
 * for the room (or hit the page cap), and return the recovered events
 * OLDEST-FIRST so the consumer sees them in wire order.
 */
async function backfillGap(
  base: string,
  token: string,
  roomId: string,
  prevBatch: string,
  lastSeenEventId: string | undefined,
  logger: MatrixSyncOptions["logger"],
  signal: AbortSignal
): Promise<MatrixTimelineEvent[]> {
  const recovered: MatrixTimelineEvent[] = []
  let from = prevBatch
  for (let page = 0; page < BACKFILL_PAGE_CAP; page += 1) {
    const params = new URLSearchParams({ from, dir: "b", limit: String(BACKFILL_PAGE_LIMIT) })
    const resp = await abortable(
      connectorsHttpRequest({
        url: `${base}${CLIENT_V3}/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
      signal
    )
    if (resp.status < 200 || resp.status >= 300) {
      logger?.warn("matrix:sync gap backfill page failed", { roomId, status: resp.status })
      break
    }
    let body: MatrixMessagesResponse
    try {
      body = JSON.parse(resp.body) as MatrixMessagesResponse
    } catch {
      break
    }
    const chunk = body.chunk ?? []
    if (chunk.length === 0) break
    let overlapped = false
    for (const ev of chunk) {
      // dir=b pages newest→oldest; stop at the first already-seen event.
      if (lastSeenEventId !== undefined && ev.event_id === lastSeenEventId) {
        overlapped = true
        break
      }
      recovered.push(ev)
    }
    if (overlapped || !body.end) break
    from = body.end
  }
  // Collected newest→oldest; deliver oldest-first.
  recovered.reverse()
  return recovered
}

export async function* startMatrixSync(opts: MatrixSyncOptions): AsyncGenerator<MatrixRoomEvent> {
  const base = normalizeHomeserver(opts.homeserver)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const backoffBaseMs = opts._backoffBaseMs ?? 1000

  // A persisted cursor means the "first" sync is downtime catch-up — deliver
  // it. Only a first-ever start (no cursor anywhere) primes-and-discards.
  let since: string | undefined = opts.initialSince
  let primed = opts.initialSince !== undefined
  let attempts = 0
  /** Rooms we already attempted to join — a failing join must not loop. */
  const attemptedJoins = new Set<string>()
  /** Last delivered event id per room, for gap-backfill overlap detection. */
  const lastSeenByRoom = new Map<string, string>()

  /**
   * Whether this request has already spent its one refresh. Reset per
   * iteration so a token that expires again hours later can still be renewed —
   * the latch bounds retries within one request, not for the life of the loop.
   */
  let refreshedThisRequest = false

  while (!opts.signal.aborted) {
    const token = await opts.accessToken()
    const params = new URLSearchParams()
    if (since) params.set("since", since)
    // First sync resolves the cursor with no wait; later syncs long-poll.
    params.set("timeout", since ? String(timeoutMs) : "0")
    params.set("filter", syncFilter(primed))
    // A bot poll must not mark the account online on every request.
    params.set("set_presence", "offline")
    const url = `${base}${CLIENT_V3}/sync?${params.toString()}`

    try {
      const resp = await abortable(
        connectorsHttpRequest({
          url,
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          timeoutMs: timeoutMs + 10_000,
        }),
        opts.signal
      )

      if (resp.status >= 500) throw new Error(`Matrix sync ${resp.status}`)
      const body = JSON.parse(resp.body) as MatrixSyncResponse & {
        error?: string
        errcode?: string
        soft_logout?: boolean
        retry_after_ms?: number
      }
      if (resp.status === 401 || body.errcode === "M_UNKNOWN_TOKEN" || body.soft_logout === true) {
        const detail = `${body.errcode ?? resp.status}${body.soft_logout ? " (soft_logout)" : ""}`
        // An expired access token is recoverable without losing the device (and
        // with it every E2EE key it holds), so try exactly one refresh before
        // declaring the bot dead. Exactly one: a homeserver that keeps handing
        // back 401 after a successful refresh is not going to be argued out of
        // it, and looping would hammer the refresh endpoint.
        if (opts.refreshAccessToken && !refreshedThisRequest) {
          refreshedThisRequest = true
          // Defensive: this is an injected callback inside a retry loop, so a
          // throw must not be mistaken for a transport error and spun on.
          const refreshed = await opts.refreshAccessToken().catch((err: unknown) => ({
            ok: false as const,
            needsReauth: false,
            error: err instanceof Error ? err.message : String(err),
          }))
          if (refreshed.ok) {
            // Retry the SAME request — `since` is untouched, so no batch is
            // skipped and none is delivered twice.
            continue
          }
          if (!refreshed.needsReauth) {
            // Transient (network, keyring): back off and retry rather than
            // pushing the user into re-authentication over a flaky connection.
            attempts += 1
            await delay(reconnectBackoffMs(backoffBaseMs, attempts), opts.signal)
            continue
          }
          throw new MatrixSyncAuthError(`Matrix sync auth failed: ${detail} — ${refreshed.error}`)
        }
        // Dead token — retrying forever would mask the auth failure while
        // health stays "running". Surface it and stop the loop.
        throw new MatrixSyncAuthError(`Matrix sync auth failed: ${detail}`)
      }
      if (resp.status === 429) {
        const retryAfterMs = typeof body.retry_after_ms === "number" ? body.retry_after_ms : 5_000
        await delay(retryAfterMs, opts.signal)
        continue
      }
      if (!body.next_batch) throw new Error(`Matrix sync: ${body.error ?? "missing next_batch"}`)

      attempts = 0
      refreshedThisRequest = false
      const nextBatch = body.next_batch
      const hasGap = Object.values(body.rooms?.join ?? {}).some(
        (room) => room.timeline?.limited === true
      )

      // Auto-join invited rooms (once per room; log + continue on failure).
      const invited = body.rooms?.invite ?? {}
      for (const roomId of Object.keys(invited)) {
        if (attemptedJoins.has(roomId)) continue
        attemptedJoins.add(roomId)
        try {
          const joinResp = await abortable(
            connectorsHttpRequest({
              url: `${base}${CLIENT_V3}/join/${encodeURIComponent(roomId)}`,
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: "{}",
            }),
            opts.signal
          )
          if (joinResp.status < 200 || joinResp.status >= 300) {
            opts.logger?.warn("matrix:sync auto-join failed", {
              roomId,
              status: joinResp.status,
            })
          }
        } catch (err) {
          opts.logger?.warn("matrix:sync auto-join failed", {
            roomId,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Olm to-device/device-list changes and authoritative room state must be
      // applied before decrypting timeline events from the same sync batch.
      await opts.onSyncResponse?.(body, hasGap)

      if (primed) {
        const joined = body.rooms?.join ?? {}
        for (const [roomId, room] of Object.entries(joined)) {
          const timeline = room.timeline ?? {}
          let events = timeline.events ?? []
          // A limited timeline silently dropped events between our cursor and
          // the batch — recover them (oldest-first) before the batch's own.
          if (timeline.limited === true && timeline.prev_batch) {
            try {
              const gap = await backfillGap(
                base,
                token,
                roomId,
                timeline.prev_batch,
                lastSeenByRoom.get(roomId),
                opts.logger,
                opts.signal
              )
              if (gap.length > 0) events = [...gap, ...events]
            } catch (err) {
              opts.logger?.warn("matrix:sync gap backfill failed", {
                roomId,
                reason: err instanceof Error ? err.message : String(err),
              })
            }
          }
          for (const event of events) {
            if (opts.signal.aborted) return
            lastSeenByRoom.set(roomId, event.event_id)
            yield { roomId, event }
          }
        }
      } else {
        // Discard the priming batch (recent history) — we only act on events
        // that arrive after the adapter's first-ever start.
        primed = true
      }

      if (opts.canAdvanceCursor?.() === false) {
        opts.logger?.warn("matrix:sync cursor held for encrypted-event recovery", {
          nextBatch,
        })
        await delay(1_000, opts.signal)
      } else {
        since = nextBatch
        opts.onNextBatch?.(nextBatch)
      }
    } catch (err) {
      if (opts.signal.aborted) return
      if (err instanceof DOMException && err.name === "AbortError") return
      if (err instanceof MatrixSyncAuthError) throw err
      attempts += 1
      const backoffMs = reconnectBackoffMs(backoffBaseMs, attempts)
      try {
        await delay(backoffMs, opts.signal)
      } catch {
        return
      }
    }
  }
}
