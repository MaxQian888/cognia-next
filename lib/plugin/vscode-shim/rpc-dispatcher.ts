/**
 * Renderer-side JSON-RPC dispatcher for the VS Code extension host.
 *
 * The Tauri Rust side forwards every sidecar-initiated frame as a Tauri
 * event named `vscode://rpc/<pluginId>` (see
 * `src-tauri/src/plugin_api/vscode/commands.rs`). This module:
 *
 *   1. Owns a global method → handler registry (`registerMethod`).
 *   2. For each inbound frame, looks up the handler by `method`, runs it,
 *      and — if the frame has an `id` — sends the result back to the
 *      sidecar through the `plugin_vscode_send_response` Tauri command.
 *   3. Surfaces handler errors as JSON-RPC `error` payloads so the
 *      sidecar's RPC client can reject the matching pending future.
 *
 * Handlers are method-keyed (not pluginId-scoped): one canonical handler
 * per VS Code API method, with pluginId arriving in the payload. This
 * keeps the dispatch O(1) and lets a single handler (e.g.
 * `languages:registerProvider`) deduplicate setup across many extensions.
 *
 * Notification handlers may return `void`; request handlers must return
 * a JSON-serialisable value (or `null`). Throwing inside either is fine —
 * it converts to a JSON-RPC error.
 */

import { loggers } from "@/lib/logger"

const dispatcherLogger = loggers.plugin.child("vscode-rpc-dispatcher")

export type RpcHandler = (payload: unknown, context: RpcContext) => Promise<unknown> | unknown

export interface RpcContext {
  pluginId: string
  method: string
  /** Original JSON-RPC `id`; `null` for notifications. */
  requestId: number | string | null
}

interface InboundFrame {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type SendResponseFn = (pluginId: string, responseJson: string) => Promise<void>
type ListenFn = (event: string, cb: (payload: { payload: string }) => void) => Promise<() => void>

const handlers = new Map<string, RpcHandler>()
const subscriptions = new Map<string, () => void>()

let sendResponseImpl: SendResponseFn | null = null
let listenImpl: ListenFn | null = null

/**
 * Wire the dispatcher to its Tauri transport. Called by
 * `lib/plugin/core/vscode-loader.ts` once at app bootstrap (or per test).
 * Passing both `null`s tears the dispatcher down.
 */
export function configureRpcDispatcher(
  options: {
    sendResponse: SendResponseFn
    listen: ListenFn
  } | null
): void {
  if (!options) {
    sendResponseImpl = null
    listenImpl = null
    for (const unlisten of subscriptions.values()) {
      try {
        unlisten()
      } catch (err) {
        dispatcherLogger.warn("unlisten failed during teardown", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    subscriptions.clear()
    return
  }
  sendResponseImpl = options.sendResponse
  listenImpl = options.listen
}

/**
 * Register (or replace) the handler for a VS Code RPC method. Returns a
 * disposer that drops the registration.
 */
export function registerMethod(method: string, handler: RpcHandler): () => void {
  if (handlers.has(method)) {
    dispatcherLogger.debug("replacing existing handler", { method })
  }
  handlers.set(method, handler)
  return () => {
    if (handlers.get(method) === handler) {
      handlers.delete(method)
    }
  }
}

/**
 * Drop every registered handler — used by tests for clean isolation.
 */
export function resetRegistry(): void {
  handlers.clear()
}

export function listRegisteredMethods(): string[] {
  return [...handlers.keys()].sort()
}

/**
 * Start listening for `vscode://rpc/<pluginId>` events on behalf of a
 * loaded extension. The returned disposer unlistens and is safe to call
 * multiple times.
 */
export async function subscribeToVscodeEvents(pluginId: string): Promise<() => void> {
  if (!listenImpl) {
    throw new Error(
      "rpc-dispatcher: configureRpcDispatcher must be called before subscribeToVscodeEvents"
    )
  }
  // Idempotent: re-subscribing returns the existing disposer.
  const existing = subscriptions.get(pluginId)
  if (existing) return existing

  const eventName = `vscode://rpc/${pluginId}`
  const unlisten = await listenImpl(eventName, (event) => {
    void handleInboundFrame(pluginId, event.payload)
  })

  let disposed = false
  const disposer = () => {
    if (disposed) return
    disposed = true
    try {
      unlisten()
    } catch (err) {
      dispatcherLogger.warn("unlisten threw", {
        pluginId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    subscriptions.delete(pluginId)
  }
  subscriptions.set(pluginId, disposer)
  return disposer
}

/**
 * Internal — dispatch a single inbound frame. Exported for tests.
 */
export async function handleInboundFrame(pluginId: string, raw: string): Promise<void> {
  let frame: InboundFrame
  try {
    frame = JSON.parse(raw) as InboundFrame
  } catch (err) {
    dispatcherLogger.warn("dropping unparseable frame", {
      pluginId,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  if (!frame.method) {
    // Pure responses are handled in Rust (pending oneshot map); only
    // method-carrying frames should reach us. Log and ignore.
    return
  }

  const isRequest = frame.id !== undefined && frame.id !== null
  const handler = handlers.get(frame.method)

  if (!handler) {
    if (isRequest) {
      await emitError(
        pluginId,
        frame.id as number | string,
        -32601,
        `method not found: ${frame.method}`
      )
    } else {
      dispatcherLogger.debug("no handler for notification", { method: frame.method, pluginId })
    }
    return
  }

  try {
    const result = await handler(frame.params, {
      pluginId,
      method: frame.method,
      requestId: isRequest ? (frame.id as number | string) : null,
    })
    if (isRequest) {
      await emitResult(pluginId, frame.id as number | string, result ?? null)
    }
  } catch (err) {
    if (isRequest) {
      const message = err instanceof Error ? err.message : String(err)
      await emitError(pluginId, frame.id as number | string, -32000, message)
    } else {
      dispatcherLogger.warn("notification handler threw", {
        method: frame.method,
        pluginId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

async function emitResult(pluginId: string, id: number | string, result: unknown): Promise<void> {
  if (!sendResponseImpl) {
    dispatcherLogger.warn("emitResult called before configureRpcDispatcher; dropping", {
      pluginId,
      id,
    })
    return
  }
  const frame = JSON.stringify({ jsonrpc: "2.0", id, result })
  try {
    await sendResponseImpl(pluginId, frame)
  } catch (err) {
    dispatcherLogger.warn("sendResponse failed", {
      pluginId,
      id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function emitError(
  pluginId: string,
  id: number | string,
  code: number,
  message: string
): Promise<void> {
  if (!sendResponseImpl) {
    dispatcherLogger.warn("emitError called before configureRpcDispatcher; dropping", {
      pluginId,
      id,
    })
    return
  }
  const frame = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })
  try {
    await sendResponseImpl(pluginId, frame)
  } catch (err) {
    dispatcherLogger.warn("sendResponse (error frame) failed", {
      pluginId,
      id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
