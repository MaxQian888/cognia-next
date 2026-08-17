/**
 * QQ Official Bot gateway WebSocket client.
 *
 * QQ's gateway is modelled on Discord's (same op codes), so this mirrors the
 * Discord gateway client structure, differing only in:
 *   - IDENTIFY token format: `QQBot <access_token>` (token resolved fresh).
 *   - dispatch events: GROUP_AT / C2C / AT / DIRECT message creates + READY.
 *   - intents default covering group/C2C + public guild + direct messages.
 *
 * Inbound frames arrive via Tauri events at `connectors://ws/<id>/message`.
 */

import { connectorListen } from "@/lib/connectors/events"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import { QQ_MESSAGE_EVENTS, type QQDispatch } from "./parse"

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/**
 * PUBLIC_GUILD_MESSAGES (1<<30) | GROUP_AND_C2C_EVENT (1<<25) |
 * DIRECT_MESSAGE (1<<12) = 1107300352.
 */
export const DEFAULT_QQ_INTENTS = (1 << 30) | (1 << 25) | (1 << 12)

export interface QQGatewayOptions {
  /** Resolves a fresh access token for IDENTIFY (without the `QQBot ` prefix). */
  accessToken: () => Promise<string>
  /** Resolves the gateway URL (GET /gateway) — called once per connect. */
  gatewayUrl: () => Promise<string>
  intents?: number
  signal: AbortSignal
  /**
   * Fired when the platform answers OP 9 INVALID_SESSION (our IDENTIFY /
   * RESUME was rejected). The adapter uses it to evict its cached app token
   * so the reconnect re-mints instead of retrying a rejected credential.
   * Errors are swallowed — the reconnect loop must never die on a callback.
   */
  onAuthInvalid?: () => void | Promise<void>
  _backoffBaseMs?: number
}

export interface QQGatewayClient {
  readonly selfId: string
  readonly dispatches: AsyncGenerator<QQDispatch>
}

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

export function startQQGateway(opts: QQGatewayOptions): QQGatewayClient {
  const intents = opts.intents ?? DEFAULT_QQ_INTENTS
  const backoffBaseMs = opts._backoffBaseMs ?? 1000

  const session = {
    sessionId: null as string | null,
    sequence: null as number | null,
  }
  let selfId = ""
  let attempts = 0

  async function* generate(): AsyncGenerator<QQDispatch> {
    while (!opts.signal.aborted) {
      let url: string
      try {
        url = await opts.gatewayUrl()
      } catch {
        if (opts.signal.aborted) return
        attempts += 1
        try {
          await delay(reconnectBackoffMs(backoffBaseMs, attempts), opts.signal)
        } catch {
          return
        }
        continue
      }

      let handleId: string
      try {
        handleId = await connectorsWsOpen(url)
      } catch {
        if (opts.signal.aborted) return
        attempts += 1
        try {
          await delay(reconnectBackoffMs(backoffBaseMs, attempts), opts.signal)
        } catch {
          return
        }
        continue
      }

      if (opts.signal.aborted) return

      const queue: string[] = []
      let wakeResolve: (() => void) | null = null
      let wsEnded = false

      const unlisten = await connectorListen<string>(
        `connectors://ws/${handleId}/message`,
        (event) => {
          queue.push(event.payload)
          wakeResolve?.()
          wakeResolve = null
        }
      )
      const unlistenClose = await connectorListen<void>(`connectors://ws/${handleId}/close`, () => {
        wsEnded = true
        wakeResolve?.()
        wakeResolve = null
      })
      const abortHandler = () => {
        wsEnded = true
        wakeResolve?.()
        wakeResolve = null
        void connectorsWsClose(handleId).catch(() => {})
      }
      opts.signal.addEventListener("abort", abortHandler)

      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
      // Heartbeats sent since the last HEARTBEAT_ACK — 2 consecutive
      // unacknowledged beats means the socket is half-open (zombie); close
      // it so the reconnect loop takes over instead of "running" forever.
      let unackedHeartbeats = 0

      try {
        while (!wsEnded && !opts.signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              wakeResolve = r
            })
          }
          while (queue.length > 0 && !wsEnded) {
            const raw = queue.shift()!
            let msg: { op: number; d?: unknown; s?: number; t?: string }
            try {
              msg = JSON.parse(raw)
            } catch {
              continue
            }
            if (msg.s !== undefined && msg.s !== null) session.sequence = msg.s

            switch (msg.op) {
              case OP_HELLO: {
                const { heartbeat_interval } = msg.d as { heartbeat_interval: number }
                const sendHeartbeat = () => {
                  if (opts.signal.aborted || wsEnded) return
                  if (unackedHeartbeats >= 2) {
                    // Zombie socket: two heartbeats in a row got no ACK.
                    wsEnded = true
                    wakeResolve?.()
                    wakeResolve = null
                    void connectorsWsClose(handleId).catch(() => {})
                    return
                  }
                  unackedHeartbeats += 1
                  void connectorsWsSend(
                    handleId,
                    JSON.stringify({ op: OP_HEARTBEAT, d: session.sequence })
                  ).catch(() => {})
                  heartbeatTimer = setTimeout(sendHeartbeat, heartbeat_interval)
                }
                heartbeatTimer = setTimeout(
                  sendHeartbeat,
                  Math.floor(Math.random() * heartbeat_interval)
                )

                try {
                  const token = await opts.accessToken()
                  if (session.sessionId) {
                    await connectorsWsSend(
                      handleId,
                      JSON.stringify({
                        op: OP_RESUME,
                        d: {
                          token: `QQBot ${token}`,
                          session_id: session.sessionId,
                          seq: session.sequence,
                        },
                      })
                    )
                  } else {
                    await connectorsWsSend(
                      handleId,
                      JSON.stringify({
                        op: OP_IDENTIFY,
                        d: {
                          token: `QQBot ${token}`,
                          intents,
                          shard: [0, 1],
                          properties: {},
                        },
                      })
                    )
                  }
                } catch {
                  // A transient token-mint / ws-send failure must not unwind
                  // the async generator — index.ts consumes it in a single
                  // for-await with no restart loop, so a throw here would
                  // permanently kill the adapter. Treat it as a connection
                  // end and let the outer backoff loop reconnect.
                  wsEnded = true
                }
                break
              }
              case OP_DISPATCH: {
                if (msg.t === "READY") {
                  const ready = msg.d as { user?: { id?: string }; session_id?: string }
                  selfId = ready.user?.id ?? selfId
                  session.sessionId = ready.session_id ?? null
                  attempts = 0
                } else if (msg.t === "RESUMED") {
                  // A successful RESUME is just as healthy as READY — reset
                  // the backoff counter so a later disconnect doesn't start
                  // from an inflated attempt count.
                  attempts = 0
                } else if (msg.t && QQ_MESSAGE_EVENTS.includes(msg.t)) {
                  yield { t: msg.t, s: msg.s, op: OP_DISPATCH, d: msg.d as QQDispatch["d"] }
                }
                break
              }
              case OP_RECONNECT:
                wsEnded = true
                break
              case OP_INVALID_SESSION:
                session.sessionId = null
                session.sequence = null
                wsEnded = true
                try {
                  await opts.onAuthInvalid?.()
                } catch {
                  /* best-effort — never break the reconnect loop */
                }
                break
              case OP_HEARTBEAT_ACK:
                unackedHeartbeats = 0
                break
              case OP_HEARTBEAT:
                break
            }
          }
        }
      } finally {
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
        opts.signal.removeEventListener("abort", abortHandler)
        unlisten()
        unlistenClose()
        if (!opts.signal.aborted) void connectorsWsClose(handleId).catch(() => {})
      }

      if (opts.signal.aborted) return
      attempts += 1
      try {
        await delay(reconnectBackoffMs(backoffBaseMs, attempts), opts.signal)
      } catch {
        return
      }
    }
  }

  const dispatches = generate()
  return {
    get selfId() {
      return selfId
    },
    dispatches,
  }
}
