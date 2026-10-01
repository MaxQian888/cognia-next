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
import { OneBotRpcError, type OneBotTransport, type OneBotTransportHandlers } from "./transport"

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
    const onAbort = () => {
      clearTimeout(tid)
      reject(new DOMException("Aborted", "AbortError"))
    }
    const tid = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function createForwardWsTransport(opts: ForwardWsOptions): OneBotTransport {
  const pending = new Map<
    string,
    { resolve: (resp: OneBotRpcResponse) => void; reject: (error: Error) => void }
  >()
  const backoffBaseMs = opts._backoffBaseMs ?? 1000
  let abort = new AbortController()
  let generation = 0
  let handlers: OneBotTransportHandlers | null = null
  let handleId: string | null = null
  const unlisteners: UnlistenFn[] = []
  let attempts = 0
  let failedConnects = 0

  function cleanupListeners(): void {
    for (const unlisten of unlisteners.splice(0)) {
      try {
        unlisten()
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  function rejectPending(message: string): void {
    for (const rpc of pending.values()) rpc.reject(new OneBotRpcError(message))
    pending.clear()
  }

  function routeFrame(payload: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      // Only an action response settles a call; an event that happens to carry
      // a matching `echo` must not swallow the real response.
      if (
        typeof obj.echo === "string" &&
        pending.has(obj.echo) &&
        ("retcode" in obj || "status" in obj)
      ) {
        const rpc = pending.get(obj.echo)!
        pending.delete(obj.echo)
        rpc.resolve(obj as unknown as OneBotRpcResponse)
        return
      }
    }
    void handlers?.onEvent(parsed)
  }

  const isActive = (epoch: number) =>
    epoch === generation && !abort.signal.aborted && handlers !== null

  async function closeSocket(id: string): Promise<void> {
    try {
      await connectorsWsClose(id)
    } catch {
      /* already closed */
    }
  }

  async function connectOnce(epoch: number): Promise<void> {
    const token = opts.token ? await opts.token() : ""
    if (!isActive(epoch)) return
    const id = await connectorsWsOpen(
      opts.url,
      token ? { Authorization: `Bearer ${token}` } : undefined
    )
    if (!isActive(epoch)) {
      await closeSocket(id)
      return
    }
    handleId = id
    let closed = false
    const live = () => isActive(epoch) && !closed && handleId === id
    const register = async (listener: Promise<UnlistenFn>): Promise<boolean> => {
      const unlisten = await listener
      if (!live()) {
        unlisten()
        return false
      }
      unlisteners.push(unlisten)
      return true
    }
    try {
      if (
        !(await register(
          connectorListen<string>(`connectors://ws/${id}/message`, (e) => {
            if (live()) routeFrame(e.payload)
          })
        ))
      )
        return
      if (
        !(await register(
          connectorListen<void>(`connectors://ws/${id}/close`, () => {
            if (!live()) return
            closed = true
            handleId = null
            rejectPending("OneBot connection closed before acknowledgement")
            handlers?.onClose()
            void scheduleReconnect(epoch)
          })
        ))
      )
        return
      attempts = 0
      failedConnects = 0
      handlers?.onOpen()
    } catch (error) {
      closed = true
      if (isActive(epoch)) {
        handleId = null
        cleanupListeners()
      }
      await closeSocket(id)
      throw error
    }
  }

  async function scheduleReconnect(epoch: number): Promise<void> {
    if (!isActive(epoch)) return
    cleanupListeners()
    attempts += 1
    try {
      await delay(reconnectBackoffMs(backoffBaseMs, attempts), abort.signal)
    } catch {
      return
    }
    if (!isActive(epoch)) return
    try {
      await connectOnce(epoch)
    } catch {
      if (!isActive(epoch)) return
      handlers?.onConnectFailed?.(++failedConnects)
      void scheduleReconnect(epoch)
    }
  }

  async function stop(): Promise<void> {
    generation += 1
    abort.abort()
    handlers = null
    cleanupListeners()
    const id = handleId
    handleId = null
    rejectPending("OneBot transport stopped before acknowledgement")
    if (id) await closeSocket(id)
  }

  return {
    async start(h): Promise<void> {
      if (handlers) await stop()
      abort = new AbortController()
      const epoch = ++generation
      handlers = h
      attempts = 0
      failedConnects = 0
      try {
        await connectOnce(epoch)
      } catch {
        if (!isActive(epoch)) return
        handlers?.onConnectFailed?.(++failedConnects)
        void scheduleReconnect(epoch)
      }
    },
    send(call: SerializedOneBotCall, timeoutMs = 10_000): Promise<OneBotRpcResponse> {
      const id = handleId
      if (!id)
        return Promise.reject(new Error(`OneBot forward-WS not connected: action=${call.action}`))
      return new Promise((resolve, reject) => {
        const fail = (error: Error) => {
          clearTimeout(timer)
          pending.delete(call.echo)
          reject(error)
        }
        const timer = setTimeout(
          () =>
            fail(new OneBotRpcError(`OneBot RPC timeout: echo=${call.echo} action=${call.action}`)),
          timeoutMs
        )
        pending.set(call.echo, {
          resolve: (response) => {
            clearTimeout(timer)
            resolve(response)
          },
          reject: fail,
        })
        connectorsWsSend(id, JSON.stringify(call)).catch((error) => {
          fail(new OneBotRpcError(error instanceof Error ? error.message : String(error)))
        })
      })
    },
    stop,
  }
}
