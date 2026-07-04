// Protocol-adapter registry (one-api `GetAdaptor` analog). Resolution order:
// the five built-in AI SDK protocols win unconditionally; anything else needs
// a declarative spec forwarded by the renderer (`sendOptions.
// protocolAdapterSpec`, contributed by a plugin). No match → null and the
// dispatcher emits the same "no resolvable protocol" session_ended as before.

import { makeAiSdkAdapter } from "./ai-sdk-adapter.mjs"
import { makeCodeAdapter } from "./code-adapter.mjs"
import { makeOpenAiCompatVariantAdapter } from "./openai-compatible-variant-adapter.mjs"
import { BUILTIN_PROTOCOL_NAMES } from "./provider-protocol.mjs"

/**
 * Protocols the built-in `@ai-sdk/*` adapter handles, derived from the single
 * source of truth so this can't drift from `buildRawModel`'s switch. The
 * renderer's BUILTIN_API_PROTOCOLS maps onto this set (gemini → google); this
 * set holds the EXECUTION names, so `isBuiltinProtocol` deliberately does NOT
 * normalize — a raw `gemini` is rejected because it has no `buildRawModel` case
 * (it only reaches the registry already normalized to `google`).
 */
export const BUILTIN_PROTOCOLS = new Set(BUILTIN_PROTOCOL_NAMES)

/** @param {string|null|undefined} protocol */
export function isBuiltinProtocol(protocol) {
  return typeof protocol === "string" && BUILTIN_PROTOCOLS.has(protocol)
}

/**
 * @param {string|null|undefined} protocol  Resolved protocol id.
 * @param {any} [spec]  Adapter spec from sendOptions, if any.
 * @param {{ emit: Function, sessionId: string, pendingProtocolExecs: Map<string, any>, onCancel?: Function }} [codeBridge]
 *   Runtime deps required to execute a `kind: "code"` adapter (renderer
 *   round-trip). Absent for builtin / declarative resolution.
 * @returns {import("./types.mjs").ProtocolAdapter | null}
 */
export function resolveAdapter(protocol, spec, codeBridge) {
  if (isBuiltinProtocol(protocol)) return makeAiSdkAdapter(protocol)
  if (spec && spec.kind === "openai-compatible-variant") {
    return makeOpenAiCompatVariantAdapter(spec)
  }
  // Code-level adapters need the renderer round-trip bridge; without it (e.g.
  // a /v1/models-style probe) they're unresolvable.
  if (spec && spec.kind === "code" && codeBridge) {
    return makeCodeAdapter(spec, codeBridge)
  }
  return null
}
