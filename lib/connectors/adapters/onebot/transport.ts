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
}

export interface OneBotTransport {
  /** Wire up listeners and (for forward-ws) dial the server. */
  start(handlers: OneBotTransportHandlers): Promise<void>
  /** Send an RPC action and resolve on the echo-matched response. */
  send(call: SerializedOneBotCall, timeoutMs?: number): Promise<OneBotRpcResponse>
  /** Tear down listeners and (for forward-ws) close the socket. */
  stop(): Promise<void>
}
