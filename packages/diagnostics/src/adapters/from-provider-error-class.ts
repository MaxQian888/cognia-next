/**
 * `ProviderErrorClass` → {@link DiagnosticCode}.
 *
 * `packages/provider-routing`'s classifier is the authority on provider
 * failures: it reads the real HTTP status and Retry-After the sidecar captured
 * from the response, and `TRANSIENT_ERROR_CLASSES` already encodes which
 * classes are worth another attempt. None of that is re-derived here — this
 * adapter only renames its nine classes into the shared vocabulary and carries
 * the retry hint through so a countdown can be rendered instead of guessed.
 *
 * The `Record` is total, so a tenth provider class upstream is a compile error
 * rather than a silent fall-through to `unknown`.
 */

import type { ProviderErrorClass } from "@cognia/provider-types/error-class"

import type { DiagnosticCode, DiagnosticMeta } from "../types"

export const PROVIDER_CLASS_TO_CODE: Readonly<Record<ProviderErrorClass, DiagnosticCode>> = {
  "rate-limit": "rateLimited",
  timeout: "timeout",
  network: "fetchFailed",
  "server-error": "serverError",
  "context-window-exceeded": "contextWindowExceeded",
  "content-policy": "contentPolicy",
  auth: "unauthorized",
  "invalid-request": "invalidRequest",
  unknown: "unknown",
}

/** Structural subset of `ProviderErrorInfo` — avoids a runtime package edge. */
export interface ProviderErrorInfoLike {
  errorClass: ProviderErrorClass
  retryAfterMs?: number
}

export interface ProviderDiagnosis {
  code: DiagnosticCode
  meta: DiagnosticMeta
}

/**
 * Map a classified provider error, folding its Retry-After and HTTP status into
 * `meta` where `createDiagnostic` can turn them into a countdown action.
 */
export function diagnoseProviderError(
  info: ProviderErrorInfoLike,
  extra: { httpStatus?: number; providerId?: string; modelId?: string } = {}
): ProviderDiagnosis {
  const meta: DiagnosticMeta = {}
  if (info.retryAfterMs !== undefined) meta.retryAfterMs = info.retryAfterMs
  if (extra.httpStatus !== undefined) meta.httpStatus = extra.httpStatus
  if (extra.providerId !== undefined) meta.providerId = extra.providerId
  if (extra.modelId !== undefined) meta.modelId = extra.modelId

  return { code: PROVIDER_CLASS_TO_CODE[info.errorClass], meta }
}
