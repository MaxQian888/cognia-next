/**
 * Transport abstraction for the OneBot adapter.
 *
 * OneBot v11/v12 can be reached over two duplex WebSocket topologies, both of
 * which carry the same JSON event stream and the same echo-matched RPC request
 * / response protocol — only the connection direction differs:
 *
 *   - **reverse-ws** — cognia runs the WS *server*; the OneBot client
 *     (NapCat / Lagrange / LLOneBot) dials in. (`transport-reverse-ws.ts`)
 *   - **forward-ws** — cognia is the WS *client* and dials a NapCat WS *server*
 *     (default `ws://host:3001`), the dominant NapCat deployment.
 *     (`transport-forward-ws.ts`)
 *
 * The parser / serialiser / capability layers are transport-agnostic; this
 * interface is the only seam between them and the wire.
 */

import type { SerializedOneBotCall } from "./serialize"
import type { OneBotRpcResponse } from "./transport-reverse-ws"

export type { OneBotRpcResponse }

export interface OneBotTransportHandlers {
  /** One raw inbound event frame (already JSON-parsed). */
  onEvent: (raw: unknown) => void | Promise<void>
  /** Connection opened (initial connect or reconnect). */
  onOpen: () => void
  /** Connection closed (peer/server dropped). */
  onClose: () => void
  /**
   * A dial attempt failed without ever opening (forward-ws only — reverse-ws
   * never dials). `consecutiveFailures` counts failures since the last
   * successful open, so the adapter can degrade health after N in a row.
   */
  onConnectFailed?: (consecutiveFailures: number) => void
}

export interface OneBotTransport {
  /** Wire up listeners and (for forward-ws) dial the server. */
  start(handlers: OneBotTransportHandlers): Promise<void>
  /** Send an RPC action and resolve on the echo-matched response. */
  send(call: SerializedOneBotCall, timeoutMs?: number): Promise<OneBotRpcResponse>
  /** Tear down listeners and (for forward-ws) close the socket. */
  stop(): Promise<void>
}

/** A received rejection is final; an incomplete acknowledgement must not be replayed. */
export class OneBotRpcError extends Error {
  readonly retryable = false
  constructor(
    message: string,
    readonly code: "platform_4xx" | "delivery_unknown" = "delivery_unknown"
  ) {
    super(message)
    this.name = "OneBotRpcError"
  }
}

export function assertOneBotSuccess(response: OneBotRpcResponse, action: string): void {
  if (response?.status === "ok" && response.retcode === 0) return
  const rejected =
    response?.status === "failed" &&
    Number.isInteger(response.retcode) &&
    response.retcode !== 0 &&
    response.retcode !== 1
  const detail = response?.message || response?.wording
  throw new OneBotRpcError(
    `OneBot ${action}: status=${response?.status} retcode=${response?.retcode}${detail ? ` (${detail})` : ""}`,
    rejected ? "platform_4xx" : "delivery_unknown"
  )
}

export function oneBotMessageId(response: OneBotRpcResponse, action: string): string {
  assertOneBotSuccess(response, action)
  const id = (response.data as { message_id?: unknown } | null)?.message_id
  if ((typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isFinite(id)))
    return String(id)
  throw new OneBotRpcError(`OneBot ${action}: successful acknowledgement missing message_id`)
}
