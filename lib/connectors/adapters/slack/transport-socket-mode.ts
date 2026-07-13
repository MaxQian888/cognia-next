/**
 * Slack Socket Mode WebSocket transport — Task 72.
 *
 * Drives the Slack Socket Mode protocol:
 *   1. Call apps.connections.open (POST with Authorization: Bearer <appToken>) to get a WSS URL.
 *   2. Connect via connectorsWsOpen.
 *   3. Receive hello, events_api, disconnect messages.
 *   4. For each events_api envelope, ack via { envelope_id }, then yield payload.event.
 *   5. On disconnect → reconnect via fresh apps.connections.open.
 *
 * Returns AsyncGenerator<SlackEventEnvelope>.
 */

import { listen } from "@tauri-apps/api/event"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import type { SlackEventEnvelope } from "./parse"

const SLACK_CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open"

export interface SocketModeOptions {
  /** Resolves the xapp-... app-level token used for apps.connections.open. */
  appToken: () => Promise<string>
  signal: AbortSignal
  /** Override for testing. */
  _connectionsOpenUrl?: string
  /** Backoff base ms; default 1000. */
  _backoffBaseMs?: number
}

interface ConnectionsOpenResponse {
  ok: boolean
  url?: string
  error?: string
}

interface SocketModeHelloFrame {
  type: "hello"
  num_connections?: number
}

interface SocketModeEventsApiFrame {
  type: "events_api"
  envelope_id: string
  payload: {
    type: string
    event: SlackEventEnvelope["event"]
    team_id?: string
    api_app_id?: string
  }
  accepts_response_payload?: boolean
}

interface SocketModeDisconnectFrame {
  type: "disconnect"
  reason?: string
}

type SocketModeFrame = SocketModeHelloFrame | SocketModeEventsApiFrame | SocketModeDisconnectFrame

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

async function openConnection(connectionsOpenUrl: string, appToken: string): Promise<string> {
  const resp = await connectorsHttpRequest({
    url: connectionsOpenUrl,
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "",
  })

  const parsed = JSON.parse(resp.body) as ConnectionsOpenResponse
  if (!parsed.ok || !parsed.url) {
    throw new Error(`apps.connections.open failed: ${parsed.error ?? "unknown error"}`)
  }

  return parsed.url
}

/**
 * Start a Slack Socket Mode generator that yields SlackEventEnvelopes.
 *
 * Handles hello/events_api/disconnect frames, ACKs each events_api frame,
 * and reconnects on disconnect or WS close.
 */
export async function* startSocketMode(
  opts: SocketModeOptions
): AsyncGenerator<SlackEventEnvelope> {
  const connectionsOpenUrl = opts._connectionsOpenUrl ?? SLACK_CONNECTIONS_OPEN_URL
  const backoffBaseMs = opts._backoffBaseMs ?? 1000
  let attempts = 0

  while (!opts.signal.aborted) {
    // Get a fresh WSS URL from apps.connections.open
    let wssUrl: string
    try {
      const token = await opts.appToken()
      wssUrl = await openConnection(connectionsOpenUrl, token)
    } catch {
      if (opts.signal.aborted) return
      attempts += 1
      const backoff = reconnectBackoffMs(backoffBaseMs, attempts)
      try {
        await delay(backoff, opts.signal)
      } catch {
        return
      }
      continue
    }

    // Connect to the WSS URL
    let handleId: string
    try {
      handleId = await connectorsWsOpen(wssUrl)
    } catch {
      if (opts.signal.aborted) return
      attempts += 1
      const backoff = reconnectBackoffMs(backoffBaseMs, attempts)
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

    let shouldReconnect = false

    try {
      outer: while (!wsEnded && !opts.signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            wakeResolve = r
          })
        }

        while (queue.length > 0 && !wsEnded) {
          const raw = queue.shift()!
          let frame: SocketModeFrame
          try {
            frame = JSON.parse(raw) as SocketModeFrame
          } catch {
            continue
          }

          switch (frame.type) {
            case "hello":
              // Connection established; reset backoff
              attempts = 0
              break

            case "events_api": {
              const eventsFrame = frame as SocketModeEventsApiFrame

              // ACK the envelope immediately
              await connectorsWsSend(
                handleId,
                JSON.stringify({ envelope_id: eventsFrame.envelope_id })
              ).catch(() => {})

              // Yield the inner event as a SlackEventEnvelope
              if (eventsFrame.payload?.type === "event_callback") {
                const envelope: SlackEventEnvelope = {
                  type: "event_callback",
                  event: eventsFrame.payload.event,
                  team_id: eventsFrame.payload.team_id,
                  api_app_id: eventsFrame.payload.api_app_id,
                  event_id: eventsFrame.envelope_id,
                }
                yield envelope
              }
              break
            }

            case "disconnect":
              shouldReconnect = true
              break outer

            default:
              break
          }
        }
      }
    } finally {
      opts.signal.removeEventListener("abort", abortHandler)
      unlisten()
      unlistenClose()
      if (!opts.signal.aborted) {
        void connectorsWsClose(handleId).catch(() => {})
      }
    }

    if (opts.signal.aborted) return

    // Reconnect delay (fresh apps.connections.open call each time)
    if (!shouldReconnect) {
      attempts += 1
    }
    const backoff = shouldReconnect ? 500 : reconnectBackoffMs(backoffBaseMs, attempts)
    try {
      await delay(backoff, opts.signal)
    } catch {
      return
    }
  }
}
