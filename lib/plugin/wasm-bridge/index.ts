/**
 * WASM capability bridge — renderer half.
 *
 * See `renderer-request-source.ts` for the wiring and
 * `crates/cognia-plugin-runtime/src/wasm/bridge.rs` for the host half.
 */

export { MAX_ERROR_MESSAGE_CHARS, toBridgeError, WasmBridgeError } from "./errors"
export {
  MAX_PAYLOAD_BYTES,
  parseRendererRequest,
  serializedByteLength,
  WASM_BRIDGE_ERROR_CODES,
  WASM_BRIDGE_OPERATIONS,
  WASM_RENDERER_CANCEL_EVENT,
  WASM_RENDERER_REQUEST_EVENT,
  WASM_RENDERER_RESPONSE_COMMAND,
} from "./protocol"
export type {
  WasmBridgeErrorCode,
  WasmBridgeOperation,
  WasmCancelReason,
  WasmRendererCancel,
  WasmRendererRequest,
  WasmRendererResponse,
} from "./protocol"
export {
  __resetWasmRequestRegistryForTesting,
  abortAll,
  abortAllForPlugin,
  abortReasonFor,
  beginRequest,
  cancelRequest,
  DuplicateRequestError,
  pendingCount,
  settleRequest,
} from "./request-registry"
export { dispatchWasmOperation, installWasmRendererRequestSource } from "./renderer-request-source"
export type { InstallWasmRendererOptions } from "./renderer-request-source"
