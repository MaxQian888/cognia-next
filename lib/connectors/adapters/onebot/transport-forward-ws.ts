/**
 * Forward-WebSocket transport for the OneBot adapter.
 *
 * cognia is the WS *client* and dials a NapCat (or any OneBot v11/v12) WS
 * *server* — the dominant NapCat deployment, e.g. `ws://127.0.0.1:3001`. The
 * access token, when set, is sent as an `Authorization: Bearer <token>` header
 * (NapCat also accepts it; the server may equally read `?access_token=` from
 * the URL the operator pastes).
 *
 * Reuses the generic Rust WS client (`connectors_ws_*`, proxy-aware) exactly
 * like the Discord gateway: dial via `connectorsWsOpen`, receive frames on
 * `connectors://ws/<id>/message`, and write outbound RPC via `connectorsWsSend`.
 * The same `echo`-matched request/response correlation as the reverse-WS path
 * applies — API responses carry `echo` + `status`/`retcode`; everything else is
 * a pushed event.
 */

import { connectorListen } from "@/lib/connectors/events"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import type { SerializedOneBotCall } from "./serialize"
import type { UnlistenFn, OneBotRpcResponse } from "./transport-reverse-ws"
import type { OneBotTransport, OneBotTransportHandlers } from "./transport"

export interface ForwardWsOptions {
  adapterId: string
  /** NapCat WS server URL, e.g. `ws://127.0.0.1:3001`. */
  url: string
  /** Resolves the access token (sent as `Authorization: Bearer`). Optional. */
  token?: () => Promise<string>
  /** Override reconnect backoff base ms (tests). Default 1000. */
  _backoffBaseMs?: number
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const tid = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(tid)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true }
    )
  })
}

export function createForwardWsTransport(opts: ForwardWsOptions): OneBotTransport {
  /** echo → resolver for in-flight RPCs. */
  const pending = new Map<string, (resp: OneBotRpcResponse) => void>()
  const abort = new AbortController()
  const backoffBaseMs = opts._backoffBaseMs ?? 1000

  let handlers: OneBotTransportHandlers | null = null
  let handleId: string | null = null
  let unlistenMessage: UnlistenFn | null = null
  let unlistenClose: UnlistenFn | null = null
  let attempts = 0
  /** Dial failures since the last successful open (drives onConnectFailed). */
  let failedConnects = 0

  function noteConnectFailure(): void {
    failedConnects += 1
    handlers?.onConnectFailed?.(failedConnects)
  }

  function cleanupListeners(): void {
    if (unlistenMessage) {
      try {
        unlistenMessage()
      } catch {
        /* ignore */
      }
      unlistenMessage = null
    }
    if (unlistenClose) {
      try {
        unlistenClose()
      } catch {
        /* ignore */
      }
      unlistenClose = null
    }
  }

  function routeFrame(payload: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return // ignore non-JSON frames
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      const echo = obj.echo
      if (typeof echo === "string" && pending.has(echo) && ("retcode" in obj || "status" in obj)) {
        const resolve = pending.get(echo)!
        pending.delete(echo)
        resolve(obj as unknown as OneBotRpcResponse)
        return
      }
    }
    void handlers?.onEvent(parsed)
  }

  async function connectOnce(): Promise<void> {
    const token = opts.token ? await opts.token() : ""
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    const id = await connectorsWsOpen(opts.url, headers)
    handleId = id
    attempts = 0
    failedConnects = 0
    unlistenMessage = await connectorListen<string>(`connectors://ws/${id}/message`, (e) =>
      routeFrame(e.payload)
    )
    unlistenClose = await connectorListen<void>(`connectors://ws/${id}/close`, () => {
      handleId = null
      handlers?.onClose()
      void scheduleReconnect()
    })
    handlers?.onOpen()
  }

  async function scheduleReconnect(): Promise<void> {
    cleanupListeners()
    if (abort.signal.aborted) return
    attempts += 1
    const backoff = reconnectBackoffMs(backoffBaseMs, attempts)
    try {
      await delay(backoff, abort.signal)
    } catch {
      return // aborted while waiting
    }
    if (abort.signal.aborted) return
    try {
      await connectOnce()
    } catch {
      noteConnectFailure()
      void scheduleReconnect()
    }
  }

  return {
    async start(h: OneBotTransportHandlers): Promise<void> {
      handlers = h
      try {
        await connectOnce()
      } catch {
        noteConnectFailure()
        void scheduleReconnect()
      }
    },

    send(call: SerializedOneBotCall, timeoutMs = 10_000): Promise<OneBotRpcResponse> {
      const id = handleId
      if (!id) {
        return Promise.reject(new Error(`OneBot forward-WS not connected: action=${call.action}`))
      }
      return new Promise<OneBotRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(call.echo)
          reject(new Error(`OneBot RPC timeout: echo=${call.echo} action=${call.action}`))
        }, timeoutMs)

        pending.set(call.echo, (resp) => {
          clearTimeout(timer)
          resolve(resp)
        })

        connectorsWsSend(id, JSON.stringify(call)).catch((err) => {
          clearTimeout(timer)
          pending.delete(call.echo)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })
    },

    async stop(): Promise<void> {
      abort.abort()
      cleanupListeners()
      const id = handleId
      handleId = null
      if (id) {
        try {
          await connectorsWsClose(id)
        } catch {
          /* ignore */
        }
      }
      pending.clear()
    },
  }
}
