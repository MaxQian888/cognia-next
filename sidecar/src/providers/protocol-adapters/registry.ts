// Protocol-adapter registry (one-api `GetAdaptor` analog). Resolution order:
// the five built-in AI SDK protocols win unconditionally; anything else needs
// a declarative spec forwarded by the renderer (`sendOptions.
// protocolAdapterSpec`, contributed by a plugin). No match → null and the
// dispatcher emits the same "no resolvable protocol" session_ended as before.

import { makeAiSdkAdapter } from "./ai-sdk-adapter.ts"
import { makeCodeAdapter } from "./code-adapter.ts"
import type { CodeAdapterBridge } from "./code-adapter.ts"
import { makeOpenAiCompatVariantAdapter } from "./openai-compatible-variant-adapter.ts"
import { BUILTIN_PROTOCOL_NAMES } from "../provider-protocol.ts"
import type { CodeAdapterSpec, OpenAiCompatibleVariantSpec, ProtocolAdapter } from "./types.ts"

/**
 * Protocols the built-in `@ai-sdk/*` adapter handles, derived from the single
 * source of truth so this can't drift from `buildRawModel`'s switch. The
 * renderer's BUILTIN_API_PROTOCOLS maps onto this set (gemini → google); this
 * set holds the EXECUTION names, so `isBuiltinProtocol` deliberately does NOT
 * normalize — a raw `gemini` is rejected because it has no `buildRawModel` case
 * (it only reaches the registry already normalized to `google`).
 */
export const BUILTIN_PROTOCOLS: ReadonlySet<string> = new Set(BUILTIN_PROTOCOL_NAMES)

export function isBuiltinProtocol(protocol: unknown): protocol is string {
  return typeof protocol === "string" && BUILTIN_PROTOCOLS.has(protocol)
}

/**
 * The adapter for a resolved protocol id. `spec` is the adapter spec from
 * sendOptions, if any (unvalidated). `codeBridge` carries the runtime deps a
 * `kind: "code"` adapter needs for its renderer round-trip; absent for
 * builtin / declarative resolution.
 */
export function resolveAdapter(
  protocol: unknown,
  spec?: unknown,
  codeBridge?: CodeAdapterBridge
): ProtocolAdapter | null {
  if (isBuiltinProtocol(protocol)) return makeAiSdkAdapter(protocol)
  const kind = (spec as { kind?: unknown } | null | undefined)?.kind
  if (spec && kind === "openai-compatible-variant") {
    // Validated when the adapter starts.
    return makeOpenAiCompatVariantAdapter(spec as OpenAiCompatibleVariantSpec)
  }
  // Code-level adapters need the renderer round-trip bridge; without it (e.g.
  // a /v1/models-style probe) they're unresolvable.
  if (spec && kind === "code" && codeBridge) {
    return makeCodeAdapter(spec as CodeAdapterSpec, codeBridge)
  }
  return null
}
