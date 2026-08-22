/**
 * Turning a lifecycle failure code into something a person can act on.
 *
 * Lifecycle errors carry a stable, non-localized code plus non-secret detail.
 * The UI must never render the raw code or the raw message: the code is a
 * protocol token, and the message is written for a log. This maps each code to
 * one translation key, with a single fallback for anything that is not a
 * lifecycle error at all.
 *
 * The mapping is exhaustive by construction — `Record<ExternalAgentLifecycleErrorCode, …>`
 * makes a new code a type error here rather than a silent fall-through to the
 * generic message. `lint:i18n` cannot see through the dynamic lookup, so
 * {@link LIFECYCLE_ERROR_MESSAGE_KEYS} is also asserted against both catalogues
 * by this module's test.
 *
 * @see types/agent/external-agent-lifecycle.ts
 */

import {
  EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES,
  isExternalAgentLifecycleError,
  type ExternalAgentLifecycleErrorCode,
} from "@/types/agent/external-agent-lifecycle"

/** i18n namespace these keys live under. */
export const LIFECYCLE_ERROR_NAMESPACE = "externalAgent.lifecycleErrors"

/** Key within {@link LIFECYCLE_ERROR_NAMESPACE} for each stable code. */
export const LIFECYCLE_ERROR_MESSAGE_KEYS: Record<ExternalAgentLifecycleErrorCode, string> = {
  runtime_missing: "runtimeMissing",
  version_unsupported: "versionUnsupported",
  version_uncertified: "versionUncertified",
  integrity_failed: "integrityFailed",
  credential_missing: "credentialMissing",
  adapter_unavailable: "adapterUnavailable",
  active_sessions: "activeSessions",
  runtime_referenced: "runtimeReferenced",
  consent_required: "consentRequired",
  platform_unsupported: "platformUnsupported",
}

/** Key used when the failure is not a lifecycle error at all. */
export const LIFECYCLE_ERROR_FALLBACK_KEY = "unknown"

/** Every key this module can ask a catalogue for. */
export const ALL_LIFECYCLE_ERROR_KEYS: readonly string[] = [
  ...EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES.map((code) => LIFECYCLE_ERROR_MESSAGE_KEYS[code]),
  LIFECYCLE_ERROR_FALLBACK_KEY,
]

/** Minimal shape of a `next-intl` translator scoped to the namespace. */
export type LifecycleErrorTranslator = (key: string) => string

/**
 * The message to show for a failed lifecycle operation.
 *
 * Anything that is not an `ExternalAgentLifecycleError` gets the generic
 * message rather than its own text: an unexpected failure has no user-facing
 * story, and surfacing a raw `TypeError` teaches the user nothing while leaking
 * internals.
 */
export function lifecycleErrorMessage(error: unknown, t: LifecycleErrorTranslator): string {
  if (!isExternalAgentLifecycleError(error)) return t(LIFECYCLE_ERROR_FALLBACK_KEY)
  return t(LIFECYCLE_ERROR_MESSAGE_KEYS[error.code])
}

/** The translation key one code maps to, for callers that render it themselves. */
export function lifecycleErrorKey(code: ExternalAgentLifecycleErrorCode): string {
  return LIFECYCLE_ERROR_MESSAGE_KEYS[code]
}
