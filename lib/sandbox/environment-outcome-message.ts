/**
 * One localized sentence per placement code (ADR-0182, Working Rule 4).
 *
 * Every refusal, fallback and notice a runtime environment can produce is a
 * stable snake_case code. The codes are the contract; the sentences are not,
 * and they are read by a person in their own language — in a toast, in the
 * project's Runtime environment panel, and in the connect failure the agent
 * manager raises.
 *
 * # Why the table is exhaustive rather than a template
 *
 * `REFUSAL_KEYS` and `FALLBACK_KEYS` are `Record<Code, string>`, so adding a
 * code to `EnvironmentRefusalCode` without a message stops the build. A
 * caller that built the key by interpolation (`codes.${code}`) would compile
 * fine and ship an untranslated key to whoever hit the new refusal — which is
 * exactly how the English strings in `lib/scheduler/notification-integration.ts`
 * reached a Chinese user.
 */

import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import type {
  EnvironmentRefusalCode,
  ResolutionNotice,
  SandboxFallbackCode,
} from "@/lib/project-environment/resolve-environment-spec"

import type { SandboxPlacementOutcome } from "./environment-placement"

/** The namespace every message below lives in. */
export const ENVIRONMENT_MESSAGE_NAMESPACE = "projectEnvironment.outcome"

export const REFUSAL_KEYS: Record<EnvironmentRefusalCode, string> = {
  runtime_selection_invalid: "refused.runtimeSelectionInvalid",
  sandbox_pool_disabled: "refused.sandboxPoolDisabled",
  bundle_unavailable: "refused.bundleUnavailable",
  bundle_pin_retired: "refused.bundlePinRetired",
  catalog_entry_unavailable: "refused.catalogEntryUnavailable",
  catalog_default_missing: "refused.catalogDefaultMissing",
  image_digest_not_pinned: "refused.imageDigestNotPinned",
  environment_approval_pending: "refused.approvalPending",
  environment_declaration_invalid: "refused.declarationInvalid",
  environment_declaration_restricted: "refused.declarationRestricted",
  environment_declaration_unversioned: "refused.declarationUnversioned",
  size_class_unknown: "refused.sizeClassUnknown",
  size_class_not_offered: "refused.sizeClassNotOffered",
  gpu_not_supported: "refused.gpuNotSupported",
  egress_preset_unknown: "refused.egressPresetUnknown",
  egress_domain_invalid: "refused.egressDomainInvalid",
  egress_domain_limit: "refused.egressDomainLimit",
  local_container_unavailable: "refused.localContainerUnavailable",
  environment_catalog_unreadable: "refused.catalogUnreadable",
}

export const FALLBACK_KEYS: Record<SandboxFallbackCode, string> = {
  sandbox_fallback_pool_disabled: "fallback.poolDisabled",
  sandbox_fallback_bundle_unavailable: "fallback.bundleUnavailable",
  sandbox_fallback_catalog_unreadable: "fallback.catalogUnreadable",
}

export const NOTICE_KEYS: Record<ResolutionNotice["code"], string> = {
  environment_approval_pending: "notice.approvalPending",
  environment_declaration_invalid: "notice.declarationInvalid",
  environment_declaration_restricted: "notice.declarationRestricted",
  environment_declaration_unversioned: "notice.declarationUnversioned",
}

/**
 * How the Host reported a placement it could not honour, localized.
 *
 * Distinct from the fallback table above: these arrive on
 * `external-agent://placement` from the Host's own fault rule, so a client
 * that reused the request-side sentences would say "the pool is off" about a
 * Host that tried and failed.
 */
export const HOST_FALLBACK_KEYS: Record<string, string> = {
  sandbox_fallback_pool_disabled: "hostFallback.poolDisabled",
  sandbox_fallback_bundle_unavailable: "hostFallback.bundleUnavailable",
  sandbox_fallback_driver_unavailable: "hostFallback.driverUnavailable",
  sandbox_fallback_daemon_unreachable: "hostFallback.daemonUnreachable",
  sandbox_fallback_bundle_stage_failed: "hostFallback.bundleStageFailed",
  sandbox_fallback_container_start_failed: "hostFallback.containerStartFailed",
  sandbox_fallback_store_unavailable: "hostFallback.storeUnavailable",
  sandbox_fallback_volume_unavailable: "hostFallback.volumeUnavailable",
}

/** The message key for one outcome, or `undefined` for `off` and `placed`. */
export function outcomeMessageKey(outcome: SandboxPlacementOutcome): string | undefined {
  switch (outcome.kind) {
    case "refused":
      return REFUSAL_KEYS[outcome.code]
    case "fallback":
      return FALLBACK_KEYS[outcome.code]
    default:
      return undefined
  }
}

/**
 * A resolution's `detail` as ICU values.
 *
 * `detail` may carry booleans (a spec field, a flag), which ICU has no
 * argument type for; they are passed as `"true"`/`"false"` so a message can
 * still `select` on them.
 */
export function outcomeMessageValues(
  detail: Readonly<Record<string, string | number | boolean>> | undefined
): Record<string, string | number> {
  if (!detail) return {}
  return Object.fromEntries(
    Object.entries(detail).map(([name, value]) => [
      name,
      typeof value === "boolean" ? String(value) : value,
    ])
  )
}

/**
 * The localized sentence for an outcome, or `undefined` when there is nothing
 * to say.
 *
 * `detail` is passed through as ICU values, so a message may name the entry,
 * the path or the tier that was at fault. A message that ignores them renders
 * the same either way.
 */
export async function outcomeMessage(
  outcome: SandboxPlacementOutcome
): Promise<string | undefined> {
  const key = outcomeMessageKey(outcome)
  if (!key) return undefined
  const t = await getRuntimeTranslator(ENVIRONMENT_MESSAGE_NAMESPACE)
  return t(key, outcomeMessageValues(outcome.kind === "refused" ? outcome.detail : undefined))
}

/** The localized sentences for a resolution's notices, in order. */
export async function noticeMessages(notices: ResolutionNotice[]): Promise<string[]> {
  if (notices.length === 0) return []
  const t = await getRuntimeTranslator(ENVIRONMENT_MESSAGE_NAMESPACE)
  return notices.map((notice) => t(NOTICE_KEYS[notice.code], outcomeMessageValues(notice.detail)))
}

/**
 * The localized sentence for a `sandbox_fallback_*` code the Host reported.
 *
 * Tolerant on purpose: a newer Host may send a code this build has no message
 * for, and the honest answer is the generic sentence plus the raw code rather
 * than silence or a key.
 */
export async function hostFallbackMessage(code: string): Promise<string> {
  const t = await getRuntimeTranslator(ENVIRONMENT_MESSAGE_NAMESPACE)
  const key = HOST_FALLBACK_KEYS[code]
  return key ? t(key) : t("hostFallback.unknown", { code })
}
