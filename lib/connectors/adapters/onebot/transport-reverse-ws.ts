/**
 * TS-side subscriber for the OneBot reverse-WebSocket transport.
 *
 * The Rust axum server (`/ws/onebot/:adapter_id`) accepts the WS connection
 * from NapCat/Lagrange/LLOneBot and emits Tauri events:
 *   `connectors://onebot/<adapterId>/open`
 *   `connectors://onebot/<adapterId>/event`   — one per incoming WS frame
 *   `connectors://onebot/<adapterId>/close`
 *
 * This module:
 *  1. Subscribes to `event` Tauri events and yields parsed JSON objects.
 *  2. Provides `sendToOneBot(adapterId, call)` to push an outbound RPC call
 *     to the connected client and await the echo-matched response.
 *
 * The Rust side relays outbound calls received through the
 * `connectors_onebot_send` command back over the WS.
 */

import { connectorListen } from "@/lib/connectors/events"
import { connectorsOnebotSend } from "@/lib/connectors/tauri/commands"
import type { SerializedOneBotCall } from "./serialize"
import type { OneBotTransport, OneBotTransportHandlers } from "./transport"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UnlistenFn = () => void

/** Raw OneBot RPC response (success or error). */
export interface OneBotRpcResponse {
  status: "ok" | "failed"
  retcode: number
  data: unknown
  echo: string
}

// ---------------------------------------------------------------------------
// Inbound event subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to incoming OneBot events from the reverse-WS connection for
 * `adapterId`. Calls `onEvent` with each parsed JSON payload.
 *
 * Returns a cleanup function that removes the listener.
 */
export async function subscribeOneBotEvents(
  adapterId: string,
  onEvent: (event: unknown) => void
): Promise<UnlistenFn> {
  const eventName = `connectors://onebot/${adapterId}/event`

  const unlisten = await connectorListen<string>(eventName, (tauriEvent) => {
    try {
      const parsed: unknown = JSON.parse(tauriEvent.payload)
      onEvent(parsed)
    } catch {
      // Ignore frames that aren't valid JSON
    }
  })

  return unlisten
}

/**
 * Subscribe to the open event for a given adapterId.
 * Returns a cleanup function.
 */
export async function subscribeOneBotOpen(
  adapterId: string,
  onOpen: () => void
): Promise<UnlistenFn> {
  return connectorListen<void>(`connectors://onebot/${adapterId}/open`, () => {
    onOpen()
  })
}

/**
 * Subscribe to the close event for a given adapterId.
 * Returns a cleanup function.
 */
export async function subscribeOneBotClose(
  adapterId: string,
  onClose: () => void
): Promise<UnlistenFn> {
  return connectorListen<void>(`connectors://onebot/${adapterId}/close`, () => {
    onClose()
  })
}

// ---------------------------------------------------------------------------
// Outbound RPC sender
// ---------------------------------------------------------------------------

/** Map from echo → resolver for pending RPC calls. */
const pendingRpcs = new Map<string, (response: OneBotRpcResponse) => void>()

/**
 * Register a listener for RPC responses on the given adapterId's response
 * channel. Must be called once before any `sendToOneBot` calls.
 *
 * Returns a cleanup function.
 */
export async function subscribeOneBotResponses(adapterId: string): Promise<UnlistenFn> {
  const responseTopic = `connectors://onebot/${adapterId}/response`
  return connectorListen<string>(responseTopic, (tauriEvent) => {
    try {
      const resp = JSON.parse(tauriEvent.payload) as OneBotRpcResponse
      const resolve = pendingRpcs.get(resp.echo)
      if (resolve) {
        pendingRpcs.delete(resp.echo)
        resolve(resp)
      }
    } catch {
      // Ignore malformed responses
    }
  })
}

/**
 * Send an outbound OneBot RPC call and wait for the echo-matched response.
 *
 * Sends the serialised call through the connector command plane, then resolves
 * when the matching response arrives on the response channel.
 *
 * Rejects after `timeoutMs` milliseconds (default 10 seconds).
 */
export async function sendToOneBot(
  adapterId: string,
  call: SerializedOneBotCall,
  timeoutMs = 10_000
): Promise<OneBotRpcResponse> {
  return new Promise<OneBotRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpcs.delete(call.echo)
      reject(new Error(`OneBot RPC timeout: echo=${call.echo} action=${call.action}`))
    }, timeoutMs)

    pendingRpcs.set(call.echo, (resp) => {
      clearTimeout(timer)
      resolve(resp)
    })

    connectorsOnebotSend(adapterId, JSON.stringify(call)).catch((err) => {
      clearTimeout(timer)
      pendingRpcs.delete(call.echo)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

// ---------------------------------------------------------------------------
// OneBotTransport adapter
// ---------------------------------------------------------------------------

/**
 * Wrap the reverse-WS helpers above in the {@link OneBotTransport} interface.
 *
 * Behaviour is byte-identical to the pre-abstraction adapter: the Rust axum
 * server owns the socket and bridges it through `connectors://onebot/<id>/*`
 * Tauri events, so `start` just registers the four listeners (responses first,
 * so `send` can resolve) and `send` delegates to `sendToOneBot`.
 */
export function createReverseWsTransport(adapterId: string): OneBotTransport {
  const unlisteners: UnlistenFn[] = []
  // Liveness: with no OneBot client connected to the axum route, every RPC
  // would otherwise sit out the full 10s response timeout (fetchHistory worst
  // case 50 pages × 10s). Track connection state from the open/close events
  // and fail fast instead. An inbound event frame also proves a live client —
  // covers an adapter (re)start that missed the original open event.
  let clientConnected = false

  return {
    async start(handlers: OneBotTransportHandlers): Promise<void> {
      unlisteners.push(await subscribeOneBotResponses(adapterId))
      unlisteners.push(
        await subscribeOneBotOpen(adapterId, () => {
          clientConnected = true
          handlers.onOpen()
        })
      )
      unlisteners.push(
        await subscribeOneBotClose(adapterId, () => {
          clientConnected = false
          handlers.onClose()
        })
      )
      unlisteners.push(
        await subscribeOneBotEvents(adapterId, (raw) => {
          clientConnected = true
          void handlers.onEvent(raw)
        })
      )
    },
    send(call: SerializedOneBotCall, timeoutMs?: number): Promise<OneBotRpcResponse> {
      if (!clientConnected) {
        return Promise.reject(
          new Error(`OneBot reverse-WS has no connected client: action=${call.action}`)
        )
      }
      return sendToOneBot(adapterId, call, timeoutMs)
    },
    async stop(): Promise<void> {
      for (const fn of unlisteners) {
        try {
          fn()
        } catch {
          // ignore cleanup errors
        }
      }
      unlisteners.length = 0
    },
  }
}
