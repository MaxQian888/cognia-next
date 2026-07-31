import type { BuiltInProviderProtocol } from "@cognia/provider-types/built-in-provider-catalog"
import type {
  ApiProtocol,
  ProviderVerificationStatus,
  UserProviderSettings,
} from "@cognia/provider-types"

import {
  normalizeBuiltInProviderConfig,
  normalizeCustomProviderConfig,
} from "./provider-normalization"

export type ProviderConnectivityProtocol = ApiProtocol | BuiltInProviderProtocol
export type ProviderConnectivityOutcome = "verified" | "failed" | "limited"

export interface ProviderConnectivityTarget {
  providerId: string
  protocol: ProviderConnectivityProtocol
  apiKey: string
  baseURL?: string
  requiresCredential: boolean
  requiresBaseURL: boolean
  isLocal: boolean
}

export interface ProviderConnectivityResultLike {
  success?: boolean
  outcome?: ProviderConnectivityOutcome
  authoritative?: boolean
  message?: string
}

export interface CustomProviderConnectivityInput {
  apiKey?: string
  baseURL?: string
  apiProtocol?: ApiProtocol
  enabled?: boolean
}

export function resolveBuiltInProviderConnectivityTarget(
  providerId: string,
  settings?: Partial<UserProviderSettings>
): ProviderConnectivityTarget {
  const normalized = normalizeBuiltInProviderConfig(providerId, settings)

  return {
    providerId,
    protocol: normalized.protocol,
    apiKey: normalized.apiKey,
    baseURL: normalized.baseURL,
    requiresCredential: normalized.requiresCredential,
    requiresBaseURL: normalized.requiresBaseUrl,
    isLocal: normalized.isLocal,
  }
}

export function resolveCustomProviderConnectivityTarget(
  providerId: string,
  provider?: CustomProviderConnectivityInput
): ProviderConnectivityTarget {
  const normalized = normalizeCustomProviderConfig(providerId, provider)

  return {
    providerId,
    protocol: normalized.protocol,
    apiKey: normalized.apiKey,
    baseURL: normalized.baseURL,
    requiresCredential: normalized.requiresCredential,
    requiresBaseURL: normalized.requiresBaseUrl,
    isLocal: normalized.isLocal,
  }
}

export function deriveVerificationStatusFromConnectivityResult(
  previousStatus: ProviderVerificationStatus | undefined,
  result?: ProviderConnectivityResultLike | null
): ProviderVerificationStatus {
  if (result?.success && result.authoritative !== false && result.outcome !== "limited") {
    return "verified"
  }

  return previousStatus === "verified" ? "stale" : "unverified"
}
