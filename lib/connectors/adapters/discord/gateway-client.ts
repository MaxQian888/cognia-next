/**
 * Discord Gateway WebSocket client.
 *
 * Drives the Discord Gateway v10 protocol:
 *   1. Connect to wss://gateway.discord.gg/?v=10&encoding=json
 *   2. Receive HELLO (op 10) → start heartbeat loop
 *   3. Send IDENTIFY (op 2)
 *   4. Receive READY → cache selfId
 *   5. Yield MESSAGE_CREATE / MESSAGE_UPDATE dispatches
 *   6. Resume on disconnect where possible
 *
 * Inbound messages arrive via Tauri events at connectors://ws/<id>/message.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import type { DiscordDispatch } from "./parse"

// ---------------------------------------------------------------------------
// Discord Gateway op codes
// ---------------------------------------------------------------------------

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_PRESENCE_UPDATE = 3
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"

/**
 * Default intents: GUILDS(1) | GUILD_MESSAGES(512) |
 * MESSAGE_CONTENT(32768) | DIRECT_MESSAGES(4096) = 33281
 */
export const DEFAULT_GATEWAY_INTENTS = 33281

export interface GatewayClientOptions {
  /** Bot token (without "Bot " prefix). */
  botToken: () => Promise<string>
  /** Intent bitmask. Defaults to DEFAULT_GATEWAY_INTENTS. */
  intents?: number
  signal: AbortSignal
  /** Override the Gateway URL (useful in tests). */
  _gatewayUrl?: string
  /** Override backoff base ms for tests. Default: 1000. */
  _backoffBaseMs?: number
}

export interface GatewayClient {
  /** Self user id discovered from the READY event. "" until READY is received. */
  readonly selfId: string
  /** The async generator of dispatched events. */
  readonly dispatches: AsyncGenerator<DiscordDispatch>
  /**
   * Send a Presence Update (op 3) with a Custom Status activity carrying
   * `state`. Returns false when no gateway connection is currently live
   * (presence has no REST fallback — it is gateway-only). Best-effort:
   * Discord allows ~5 presence updates/min per connection, so callers
   * should refresh at minute-cadence or slower.
   */
  updatePresence(state: string): Promise<boolean>
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

/**
 * Create a Discord Gateway client. Returns a GatewayClient with a
 * `dispatches` async generator that yields MESSAGE_CREATE / MESSAGE_UPDATE
 * dispatches, and a `selfId` property that is populated after READY.
 */
export function startGatewayClient(opts: GatewayClientOptions): GatewayClient {
  const gatewayUrl = opts._gatewayUrl ?? GATEWAY_URL
  const intents = opts.intents ?? DEFAULT_GATEWAY_INTENTS
  const backoffBaseMs = opts._backoffBaseMs ?? 1000

  const session = {
    sessionId: null as string | null,
    resumeGatewayUrl: null as string | null,
    sequence: null as number | null,
  }

  let selfId = ""
  let attempts = 0
  /** Live WS handle for out-of-band sends (presence). Null between connections. */
  let activeHandleId: string | null = null

  async function* generateDispatches(): AsyncGenerator<DiscordDispatch> {
    while (!opts.signal.aborted) {
      const connectUrl =
        session.sessionId && session.resumeGatewayUrl
          ? `${session.resumeGatewayUrl}?v=10&encoding=json`
          : gatewayUrl

      let handleId: string
      try {
        handleId = await connectorsWsOpen(connectUrl)
      } catch {
        if (opts.signal.aborted) return
        attempts += 1
        const backoff = backoffBaseMs * Math.min(Math.pow(2, attempts), 32)
        try {
          await delay(backoff, opts.signal)
        } catch {
          return
        }
        continue
      }

      if (opts.signal.aborted) return
      activeHandleId = handleId

      // Queue + wake pattern for inbound events
      const queue: string[] = []
      let wakeResolve: (() => void) | null = null
      let wsEnded = false

      const unlisten = await listen<string>(`connectors://ws/${handleId}/message`, (event) => {
        queue.push(event.payload)
        wakeResolve?.()
        wakeResolve = null
      })

      const unlistenClose = await listen<void>(`connectors://ws/${handleId}/close`, () => {
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
      let shouldResume = false

      try {
        outer: while (!wsEnded && !opts.signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              wakeResolve = r
            })
          }

          while (queue.length > 0 && !wsEnded) {
            const raw = queue.shift()!
            let msg: { op: number; d?: unknown; s?: number; t?: string }
            try {
              msg = JSON.parse(raw) as { op: number; d?: unknown; s?: number; t?: string }
            } catch {
              continue
            }

            if (msg.s !== undefined && msg.s !== null) {
              session.sequence = msg.s
            }

            switch (msg.op) {
              case OP_HELLO: {
                const { heartbeat_interval } = msg.d as { heartbeat_interval: number }

                // Heartbeat loop
                const sendHeartbeat = () => {
                  if (opts.signal.aborted || wsEnded) return
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

                // Identify or Resume
                const token = await opts.botToken()
                if (session.sessionId) {
                  await connectorsWsSend(
                    handleId,
                    JSON.stringify({
                      op: OP_RESUME,
                      d: { token, session_id: session.sessionId, seq: session.sequence },
                    })
                  )
                } else {
                  await connectorsWsSend(
                    handleId,
                    JSON.stringify({
                      op: OP_IDENTIFY,
                      d: {
                        token,
                        intents,
                        properties: { os: "linux", browser: "cognia", device: "cognia" },
                      },
                    })
                  )
                }
                break
              }

              case OP_DISPATCH: {
                if (msg.t === "READY") {
                  const ready = msg.d as {
                    user?: { id?: string }
                    session_id?: string
                    resume_gateway_url?: string
                  }
                  selfId = ready.user?.id ?? selfId
                  session.sessionId = ready.session_id ?? null
                  session.resumeGatewayUrl = ready.resume_gateway_url ?? null
                  attempts = 0
                } else if (msg.t === "MESSAGE_CREATE" || msg.t === "MESSAGE_UPDATE") {
                  yield {
                    t: msg.t,
                    s: msg.s,
                    op: OP_DISPATCH,
                    d: msg.d as DiscordDispatch["d"],
                  }
                }
                break
              }

              case OP_RECONNECT:
                shouldResume = true
                break outer

              case OP_INVALID_SESSION: {
                const resumable = msg.d as boolean
                if (!resumable) {
                  session.sessionId = null
                  session.resumeGatewayUrl = null
                  session.sequence = null
                }
                try {
                  await delay(1000 + Math.random() * 4000, opts.signal)
                } catch {
                  return
                }
                break outer
              }

              case OP_HEARTBEAT_ACK:
              case OP_HEARTBEAT:
                break
            }
          }
        }
      } finally {
        activeHandleId = null
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
        opts.signal.removeEventListener("abort", abortHandler)
        unlisten()
        unlistenClose()
        if (!opts.signal.aborted) {
          void connectorsWsClose(handleId).catch(() => {})
        }
      }

      if (opts.signal.aborted) return

      // Reconnect delay
      if (!shouldResume) {
        attempts += 1
        const backoff = backoffBaseMs * Math.min(Math.pow(2, attempts), 32)
        try {
          await delay(backoff, opts.signal)
        } catch {
          return
        }
      } else {
        try {
          await delay(500, opts.signal)
        } catch {
          return
        }
      }
    }
  }

  const dispatches = generateDispatches()

  async function updatePresence(state: string): Promise<boolean> {
    const handle = activeHandleId
    if (!handle) return false
    try {
      await connectorsWsSend(
        handle,
        JSON.stringify({
          op: OP_PRESENCE_UPDATE,
          d: {
            since: null,
            // Activity type 4 = Custom Status; bots render the `state` text.
            activities: [{ name: "Custom Status", type: 4, state }],
            status: "online",
            afk: false,
          },
        })
      )
      return true
    } catch {
      return false
    }
  }

  return {
    get selfId() {
      return selfId
    },
    dispatches,
    updatePresence,
  }
}
