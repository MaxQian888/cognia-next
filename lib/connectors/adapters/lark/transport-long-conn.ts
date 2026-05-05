/**
 * Lark WSS long-connection transport — Task 85.
 *
 * Protocol:
 *   1. POST /open-apis/im/v1/wsServer with Authorization: Bearer <tenantAccessToken>
 *      to get the WSS URL.
 *   2. Connect via connectorsWsOpen.
 *   3. Receive frames — each is a JSON object with a "type" field:
 *      - "event_push": a real Lark event envelope
 *      - "heartbeat_req": server heartbeat probe → reply with heartbeat_rsp
 *      - "heartbeat_rsp": heartbeat response (no-op)
 *   4. Send a heartbeat_req every heartbeatIntervalMs to keep the connection alive.
 *   5. On disconnect → reconnect with exponential back-off.
 *
 * Returns AsyncGenerator<LarkEventEnvelope>.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import type { LarkEventEnvelope } from "./parse"

const LARK_WS_SERVER_URL = "https://open.feishu.cn/open-apis/im/v1/wsServer"
/** Lark recommends a heartbeat every 30 seconds. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

export interface LarkLongConnOptions {
  /** Returns a fresh tenant-access-token on each call. */
  tenantAccessToken: () => Promise<string>
  signal: AbortSignal
  /** Override for testing. */
  _wsServerUrl?: string
  /** Heartbeat interval in ms; defaults to 30 000. */
  _heartbeatIntervalMs?: number
  /** Backoff base ms; default 1000. */
  _backoffBaseMs?: number
}

interface WsServerResponse {
  code?: number
  data?: {
    url?: string
  }
}

interface LarkWsFrame {
  type: string
  [k: string]: unknown
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

async function fetchWssUrl(wsServerUrl: string, tenantAccessToken: string): Promise<string> {
  const resp = await connectorsHttpRequest({
    url: wsServerUrl,
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  })

  const parsed = JSON.parse(resp.body) as WsServerResponse
  if (parsed.code !== 0 || !parsed.data?.url) {
    throw new Error(`Lark wsServer fetch failed: ${JSON.stringify(parsed)}`)
  }
  return parsed.data.url
}

/**
 * Start a Lark long-connection generator that yields LarkEventEnvelopes.
 *
 * Handles heartbeat probes, reconnects on disconnect, and cleans up on abort.
 */
export async function* startLarkLongConn(
  opts: LarkLongConnOptions
): AsyncGenerator<LarkEventEnvelope> {
  const wsServerUrl = opts._wsServerUrl ?? LARK_WS_SERVER_URL
  const heartbeatIntervalMs = opts._heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const backoffBaseMs = opts._backoffBaseMs ?? 1000
  let attempts = 0

  while (!opts.signal.aborted) {
    // Step 1: fetch WSS URL from /im/v1/wsServer
    let wssUrl: string
    try {
      const tat = await opts.tenantAccessToken()
      wssUrl = await fetchWssUrl(wsServerUrl, tat)
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

    // Step 2: open WS connection
    let handleId: string
    try {
      handleId = await connectorsWsOpen(wssUrl)
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

    // Queue + wake pattern
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

    // Heartbeat timer: sends a heartbeat_req every heartbeatIntervalMs
    let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
      void connectorsWsSend(handleId, JSON.stringify({ type: "heartbeat_req" })).catch(() => {})
    }, heartbeatIntervalMs)

    try {
      while (!wsEnded && !opts.signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            wakeResolve = r
          })
        }

        while (queue.length > 0 && !wsEnded) {
          const raw = queue.shift()!
          let frame: LarkWsFrame
          try {
            frame = JSON.parse(raw) as LarkWsFrame
          } catch {
            continue
          }

          switch (frame.type) {
            case "event_push": {
              // The event envelope is nested in the frame
              const envelope = frame["event"] as LarkEventEnvelope | undefined
              if (envelope) {
                attempts = 0 // reset backoff on successful data
                yield envelope
              }
              break
            }

            case "heartbeat_req":
              // Server probe — reply immediately
              await connectorsWsSend(handleId, JSON.stringify({ type: "heartbeat_rsp" })).catch(
                () => {}
              )
              break

            case "heartbeat_rsp":
              // Our heartbeat was ACK'd — no-op
              break

            default:
              break
          }
        }
      }
    } finally {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      opts.signal.removeEventListener("abort", abortHandler)
      unlisten()
      unlistenClose()
      if (!opts.signal.aborted) {
        void connectorsWsClose(handleId).catch(() => {})
      }
    }

    if (opts.signal.aborted) return

    // Reconnect with back-off
    attempts += 1
    const backoff = backoffBaseMs * Math.min(Math.pow(2, attempts), 32)
    try {
      await delay(backoff, opts.signal)
    } catch {
      return
    }
  }
}
