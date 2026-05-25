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
 * The Rust side must relay outbound calls received on the
 * `connectors://onebot/<adapterId>/send` event channel back over the WS.
 * Phase 1 ships the TS subscription and the send helper.
 */

import { listen, emit } from "@tauri-apps/api/event"
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

  const unlisten = await listen<string>(eventName, (tauriEvent) => {
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
  return listen<void>(`connectors://onebot/${adapterId}/open`, () => {
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
  return listen<void>(`connectors://onebot/${adapterId}/close`, () => {
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
  return listen<string>(responseTopic, (tauriEvent) => {
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
 * Emits `connectors://onebot/<adapterId>/send` with the serialised call JSON,
 * then resolves when the matching response arrives on the response channel.
 *
 * Rejects after `timeoutMs` milliseconds (default 10 seconds).
 */
export async function sendToOneBot(
  adapterId: string,
  call: SerializedOneBotCall,
  timeoutMs = 10_000
): Promise<OneBotRpcResponse> {
  const sendTopic = `connectors://onebot/${adapterId}/send`

  return new Promise<OneBotRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpcs.delete(call.echo)
      reject(new Error(`OneBot RPC timeout: echo=${call.echo} action=${call.action}`))
    }, timeoutMs)

    pendingRpcs.set(call.echo, (resp) => {
      clearTimeout(timer)
      resolve(resp)
    })

    emit(sendTopic, JSON.stringify(call)).catch((err) => {
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

  return {
    async start(handlers: OneBotTransportHandlers): Promise<void> {
      unlisteners.push(await subscribeOneBotResponses(adapterId))
      unlisteners.push(await subscribeOneBotOpen(adapterId, handlers.onOpen))
      unlisteners.push(await subscribeOneBotClose(adapterId, handlers.onClose))
      unlisteners.push(await subscribeOneBotEvents(adapterId, handlers.onEvent))
    },
    send(call: SerializedOneBotCall, timeoutMs?: number): Promise<OneBotRpcResponse> {
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
