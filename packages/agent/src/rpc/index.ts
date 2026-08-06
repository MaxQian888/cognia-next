/**
 * `@cognia/agent/rpc` — JSON-RPC 2.0 client and server for the Cognia agent.
 *
 * @example Server (used by `cognia-agent rpc`):
 * ```ts
 * import { createRpcServer } from "@cognia/agent/rpc"
 *
 * const server = await createRpcServer({
 *   runtimeOptions: { credential: { credentialEnv: "ANTHROPIC_API_KEY" } },
 * })
 * await server.serve() // reads stdin, writes stdout
 * ```
 *
 * @example Client:
 * ```ts
 * import { createRpcClient } from "@cognia/agent/rpc"
 *
 * const client = createRpcClient({ spawn: {} })
 * const { sessionId } = await client.call("session.create", { name: "test" })
 * const result = await client.call("turn.run", { sessionId, prompt: "Hello" })
 * await client.shutdown()
 * ```
 */

export { createRpcServer, type RpcServer, type RpcServerOptions } from "./server"
export {
  createRpcClient,
  RpcError,
  type RpcClient,
  type RpcClientOptions,
  type RpcCallOptions,
} from "./client"
export {
  RPC_ERROR_CODES,
  RPC_METHODS,
  RPC_PROTOCOL_VERSION,
  isJsonRpcRequest,
  makeErrorResponse,
  makeNotification,
  makeSuccessResponse,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type JsonRpcError,
  type RpcMethod,
} from "./protocol"
