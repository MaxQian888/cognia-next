/**
 * DingTalk Stream-mode WebSocket client.
 *
 * Stream mode is DingTalk's public-server-free integration: register an
 * endpoint, open a single WebSocket, and receive bot messages + card callbacks
 * + events as framed JSON. Mirrors the QQ/Discord gateway-client structure
 * (reconnect + backoff + abort), differing in the DingTalk framing:
 *
 *   1. Registration: POST /v1.0/gateway/connections/open { clientId,
 *      clientSecret, subscriptions } → { endpoint, ticket }. The ticket is
 *      single-use and expires in ~90s, so we open the socket immediately.
 *   2. Frames: { specVersion, type: "SYSTEM"|"EVENT"|"CALLBACK",
 *      headers: { messageId, topic, contentType, time }, data: "<json-string>" }.
 *   3. Every non-SYSTEM frame must be ACKed: { code: 200, message: "OK",
 *      headers: { messageId, contentType }, data: "<json>" }.
 *   4. Keepalive: a SYSTEM frame with topic "ping" must be echoed back with the
 *      same `opaque`; a SYSTEM "disconnect" frame ends the connection.
 *
 * Inbound frames arrive via Tauri events at `connectors://ws/<id>/message`.
 */

import { listen } from "@tauri-apps/api/event"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import {
  connectorsHttpRequest,
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"

const REGISTER_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open"

/** Topics we subscribe to in v1 (bot messages only; actionCard has no callback). */
export const DEFAULT_DINGTALK_SUBSCRIPTIONS = [
  { topic: "/v1.0/im/bot/messages/get", type: "CALLBACK" },
] as const

export const TOPIC_BOT_MESSAGE = "/v1.0/im/bot/messages/get"

/** A decoded, ACKed inbound frame handed to the adapter loop. */
export interface DingTalkStreamFrame {
  topic: string
  /** The frame's `data` field, already JSON-parsed. */
  data: Record<string, unknown>
}

export interface DingTalkStreamOptions {
  /** Resolves the AppKey (Stream `clientId`). */
  clientId: () => Promise<string>
  /** Resolves the AppSecret (Stream `clientSecret`). */
  clientSecret: () => Promise<string>
  subscriptions?: ReadonlyArray<{ topic: string; type: string }>
  signal: AbortSignal
  _backoffBaseMs?: number
}

export interface DingTalkStreamClient {
  readonly frames: AsyncGenerator<DingTalkStreamFrame>
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

interface RegisterResult {
  endpoint: string
  ticket: string
}

/** Register a Stream connection and return the WebSocket endpoint + ticket. */
export async function registerDingTalkConnection(
  clientId: string,
  clientSecret: string,
  subscriptions: ReadonlyArray<{ topic: string; type: string }>
): Promise<RegisterResult> {
  const resp = await connectorsHttpRequest({
    url: REGISTER_URL,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      subscriptions,
      ua: "cognia-connector/1.0.0",
      localIp: "127.0.0.1",
    }),
  })
  let parsed: { endpoint?: string; ticket?: string; message?: string }
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    throw new Error(`DingTalk gateway register returned non-JSON (status ${resp.status})`)
  }
  if (!parsed.endpoint || !parsed.ticket) {
    throw new Error(
      `DingTalk gateway register failed: ${parsed.message ?? resp.body.slice(0, 200)}`
    )
  }
  return { endpoint: parsed.endpoint, ticket: parsed.ticket }
}

function ackFrame(messageId: string, data: unknown): string {
  return JSON.stringify({
    code: 200,
    message: "OK",
    headers: { messageId, contentType: "application/json" },
    data: JSON.stringify(data ?? { response: null }),
  })
}

export function startDingTalkStream(opts: DingTalkStreamOptions): DingTalkStreamClient {
  const backoffBaseMs = opts._backoffBaseMs ?? 1000
  const subscriptions = opts.subscriptions ?? DEFAULT_DINGTALK_SUBSCRIPTIONS
  let attempts = 0

  async function* generate(): AsyncGenerator<DingTalkStreamFrame> {
    while (!opts.signal.aborted) {
      let url: string
      try {
        const clientId = await opts.clientId()
        const clientSecret = await opts.clientSecret()
        const { endpoint, ticket } = await registerDingTalkConnection(
          clientId,
          clientSecret,
          subscriptions as ReadonlyArray<{ topic: string; type: string }>
        )
        url = `${endpoint}?ticket=${encodeURIComponent(ticket)}`
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
      attempts = 0

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

      try {
        while (!wsEnded && !opts.signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              wakeResolve = r
            })
          }
          while (queue.length > 0 && !wsEnded) {
            const raw = queue.shift()!
            let frame: {
              type?: string
              headers?: { messageId?: string; topic?: string }
              data?: string
            }
            try {
              frame = JSON.parse(raw)
            } catch {
              continue
            }
            const type = frame.type ?? ""
            const topic = frame.headers?.topic ?? ""
            const messageId = frame.headers?.messageId ?? ""

            if (type === "SYSTEM") {
              if (topic === "ping") {
                // Echo the opaque value back so the server keeps the socket.
                let opaque: unknown = {}
                try {
                  opaque = frame.data ? JSON.parse(frame.data) : {}
                } catch {
                  opaque = {}
                }
                void connectorsWsSend(handleId, ackFrame(messageId, opaque)).catch(() => {})
              } else if (topic === "disconnect") {
                wsEnded = true
              }
              continue
            }

            // CALLBACK / EVENT — ACK first (fire-and-forget), then surface.
            void connectorsWsSend(handleId, ackFrame(messageId, { response: null })).catch(() => {})
            let data: Record<string, unknown> = {}
            try {
              data = frame.data ? (JSON.parse(frame.data) as Record<string, unknown>) : {}
            } catch {
              data = {}
            }
            yield { topic, data }
          }
        }
      } finally {
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

  return { frames: generate() }
}
