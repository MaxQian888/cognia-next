/**
 * Slack Socket Mode WebSocket transport — Task 72.
 *
 * Drives the Slack Socket Mode protocol:
 *   1. Call apps.connections.open (POST with Authorization: Bearer <appToken>) to get a WSS URL.
 *   2. Connect via connectorsWsOpen.
 *   3. Receive hello, events_api, interactive, slash_commands, disconnect messages.
 *   4. EVERY envelope type carrying an envelope_id (events_api, interactive,
 *      slash_commands) is acked via { envelope_id }, then yielded as a
 *      discriminated SocketModeDelivery so the adapter can route each kind.
 *   5. On disconnect → reconnect via fresh apps.connections.open.
 *
 * Returns AsyncGenerator<SocketModeDelivery>.
 */

import { listen } from "@tauri-apps/api/event"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import type { SlackEventEnvelope, SlackInteractivePayload, SlackSlashCommandPayload } from "./parse"

const SLACK_CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open"

export interface SocketModeOptions {
  /** Resolves the xapp-... app-level token used for apps.connections.open. */
  appToken: () => Promise<string>
  signal: AbortSignal
  /**
   * Invoked on each `hello` frame (connection established). The adapter
   * uses this to flip health from "starting" to "running".
   */
  onHello?: () => void
  /** Override for testing. */
  _connectionsOpenUrl?: string
  /** Backoff base ms; default 1000. */
  _backoffBaseMs?: number
}

/**
 * Discriminated delivery yielded by {@link startSocketMode} — one variant
 * per Socket Mode envelope family the adapter must route differently.
 */
export type SocketModeDelivery =
  | { kind: "event"; envelope: SlackEventEnvelope }
  | { kind: "interactive"; payload: SlackInteractivePayload }
  | { kind: "slash_command"; payload: SlackSlashCommandPayload }

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

interface SocketModeInteractiveFrame {
  type: "interactive"
  envelope_id: string
  payload: SlackInteractivePayload
}

interface SocketModeSlashCommandsFrame {
  type: "slash_commands"
  envelope_id: string
  payload: SlackSlashCommandPayload
}

interface SocketModeDisconnectFrame {
  type: "disconnect"
  reason?: string
}

type SocketModeFrame =
  | SocketModeHelloFrame
  | SocketModeEventsApiFrame
  | SocketModeInteractiveFrame
  | SocketModeSlashCommandsFrame
  | SocketModeDisconnectFrame

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
 * Start a Slack Socket Mode generator that yields SocketModeDeliveries.
 *
 * Handles hello/events_api/interactive/slash_commands/disconnect frames,
 * ACKs every frame that carries an envelope_id, and reconnects on
 * disconnect or WS close.
 */
export async function* startSocketMode(
  opts: SocketModeOptions
): AsyncGenerator<SocketModeDelivery> {
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

          // ACK anything that carries an envelope_id FIRST — Slack retries
          // (and eventually disables the app's event delivery) when
          // envelopes go un-acked, and that must not depend on whether we
          // can route the payload.
          const envelopeId = (frame as { envelope_id?: string }).envelope_id
          if (typeof envelopeId === "string" && envelopeId.length > 0) {
            await connectorsWsSend(handleId, JSON.stringify({ envelope_id: envelopeId })).catch(
              () => {}
            )
          }

          switch (frame.type) {
            case "hello":
              // Connection established; reset backoff
              attempts = 0
              opts.onHello?.()
              break

            case "events_api": {
              const eventsFrame = frame as SocketModeEventsApiFrame

              // Yield the inner event as a SlackEventEnvelope
              if (eventsFrame.payload?.type === "event_callback") {
                const envelope: SlackEventEnvelope = {
                  type: "event_callback",
                  event: eventsFrame.payload.event,
                  team_id: eventsFrame.payload.team_id,
                  api_app_id: eventsFrame.payload.api_app_id,
                  event_id: eventsFrame.envelope_id,
                }
                yield { kind: "event", envelope }
              }
              break
            }

            case "interactive": {
              const interactiveFrame = frame as SocketModeInteractiveFrame
              if (interactiveFrame.payload) {
                yield { kind: "interactive", payload: interactiveFrame.payload }
              }
              break
            }

            case "slash_commands": {
              const slashFrame = frame as SocketModeSlashCommandsFrame
              if (slashFrame.payload) {
                yield { kind: "slash_command", payload: slashFrame.payload }
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
