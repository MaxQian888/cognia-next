/**
 * Canonical adapter-error surface exposed to plugin authors.
 *
 * Sibling of the host-side `lib/plugin/errors/adapter-error.ts` — same class
 * name, same shape, so a runtime-thrown error deserializes cleanly on the
 * author side after crossing the gateway boundary.
 *
 * The code enum lives in `packages/plugin-sdk/contract/catalog.json`
 * (`errorCodes[]`) and is mirrored into `contracts/generated.ts` by
 * `scripts/plugin/generate-contract.mjs`. This module re-exports the
 * canonical type as `PluginAdapterErrorCode`.
 *
 * Ergonomic parity with `brokerError` from
 * `lib/plugin/ide/broker-runtime.ts`: a lightweight throwable with a stable
 * `code` field plus an optional `hint` for author-facing rendering.
 */

import { CANONICAL_PLUGIN_ERROR_CODES, type CanonicalPluginErrorCode } from "../contracts/generated"

export type PluginAdapterErrorCode = CanonicalPluginErrorCode

/** JSON-serializable snapshot suitable for crossing IPC / audit sinks. */
export interface PluginAdapterErrorPayload {
  name: "PluginAdapterError"
  code: PluginAdapterErrorCode
  message: string
  hint?: string
}

export class PluginAdapterError extends Error {
  readonly name = "PluginAdapterError" as const
  readonly code: PluginAdapterErrorCode
  readonly hint?: string

  constructor(code: PluginAdapterErrorCode, message?: string, hint?: string) {
    super(message ?? code)
    this.code = code
    if (hint !== undefined) this.hint = hint
  }

  toJSON(): PluginAdapterErrorPayload {
    return this.hint === undefined
      ? { name: this.name, code: this.code, message: this.message }
      : { name: this.name, code: this.code, message: this.message, hint: this.hint }
  }
}

/**
 * Factory mirroring `brokerError(...)` ergonomics — one call site produces a
 * ready-to-throw error with a validated code.
 */
export function pluginAdapterError(
  code: PluginAdapterErrorCode,
  message?: string,
  hint?: string
): PluginAdapterError {
  return new PluginAdapterError(code, message, hint)
}

/**
 * Type guard for host-side pipelines that classify unknown throwables. Uses
 * the string `name` field so cross-realm errors (deserialized from a worker,
 * a Tauri IPC payload, or a subagent transcript) still classify.
 */
export function isPluginAdapterError(value: unknown): value is PluginAdapterError {
  if (value instanceof PluginAdapterError) return true
  if (!value || typeof value !== "object") return false
  const candidate = value as { name?: unknown; code?: unknown }
  return (
    candidate.name === "PluginAdapterError" &&
    typeof candidate.code === "string" &&
    (CANONICAL_PLUGIN_ERROR_CODES as readonly string[]).includes(candidate.code)
  )
}
