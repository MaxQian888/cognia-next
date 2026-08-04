/**
 * The one place a WASM bridge error code is chosen.
 *
 * Every failure the renderer half can produce funnels through
 * [`toBridgeError`], so the mapping table has exactly one implementation and
 * one test file. Handlers throw whatever is natural (a `WasmBridgeError`, a
 * `PluginPiiError`, a provider failure) and classification happens here.
 */

import type { WasmBridgeErrorCode, WasmCancelReason } from "./protocol"

/**
 * Cap on the message text handed back to a guest.
 *
 * Provider errors routinely echo fragments of the request — a model refusing a
 * prompt often quotes it. The guest already knows its own prompt, but the
 * message also reaches host diagnostics, so bound it rather than relaying an
 * unbounded provider string.
 */
export const MAX_ERROR_MESSAGE_CHARS = 512

export class WasmBridgeError extends Error {
  readonly code: WasmBridgeErrorCode

  constructor(code: WasmBridgeErrorCode, message: string) {
    super(message)
    this.name = "WasmBridgeError"
    this.code = code
  }
}

/** Abort reasons recorded by the request registry, keyed by requestId. */
export interface AbortContext {
  abortReason?: WasmCancelReason
}

function truncate(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_CHARS) return message
  return `${message.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…`
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  return String(err)
}

function isAbort(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true
  // DOMException from an AbortController in jsdom/node.
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  )
}

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  )
}

function nameIs(err: unknown, name: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === name
  )
}

/**
 * Classify a thrown value into the stable code vocabulary.
 *
 * Ordered most-specific-first. The default is `PROVIDER_ERROR` rather than a
 * generic "unknown": by the time a throw reaches here the request was
 * authorized, validated, and dispatched, so an unrecognised failure came from
 * the backing service.
 */
export function toBridgeError(
  err: unknown,
  ctx: AbortContext = {}
): { code: WasmBridgeErrorCode; message: string } {
  // 1. Already classified.
  if (err instanceof WasmBridgeError) {
    return { code: err.code, message: truncate(err.message) }
  }

  // 2. Aborts, discriminated by why the registry aborted them. A timeout and a
  //    deactivate are both "the work stopped", but only one is the guest's
  //    problem to retry.
  if (isAbort(err)) {
    if (ctx.abortReason === "timeout") {
      return { code: "TIMEOUT", message: "the renderer did not finish in time" }
    }
    return {
      code: "CANCELLED",
      message: `request cancelled${ctx.abortReason ? ` (${ctx.abortReason})` : ""}`,
    }
  }

  // 3. The PII gate and the permission proxy are both consent failures from the
  //    guest's point of view — it asked for something it may not have.
  if (nameIs(err, "PluginPiiError") || nameIs(err, "PermissionError")) {
    return { code: "CAPABILITY_DENIED", message: truncate(messageOf(err)) }
  }

  // 4. No provider configured is a host-capability gap, not a provider failure:
  //    retrying will not help until the user configures one.
  if (hasCode(err, "NO_PROVIDER_AVAILABLE")) {
    return { code: "HOST_UNAVAILABLE", message: truncate(messageOf(err)) }
  }

  return { code: "PROVIDER_ERROR", message: truncate(messageOf(err)) }
}
