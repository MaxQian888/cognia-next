/**
 * Deployment identity (LiteLLM `Deployment` analog).
 *
 * A deployment is one concrete route a request can take: a provider, a model
 * within it, and optionally the credential used (multi-key rotation). All
 * deployment-granular telemetry — health metrics, circuit breaker, cooldown,
 * in-flight and rate windows — keys off the string form produced by
 * `deploymentKeyOf`. This module is the ONLY codec for that key; never
 * concatenate ids ad hoc.
 */

import type { ModelMappingEntry } from "./model-mapping"

/** Structured identity of a single deployment. */
export interface DeploymentKey {
  /** Provider ID (e.g., 'openai', 'groq', 'ollama'). */
  providerId: string
  /**
   * Model ID within the provider (e.g., 'gpt-4o', 'llama3:8b'). `"*"` is the
   * wildcard used when a telemetry site only knows the provider.
   */
  modelId: string
  /** Optional credential id for multi-key rotation granularity. */
  keyId?: string
}

/**
 * Separator between key segments. Single colons are common INSIDE ids
 * (Ollama tags like `llama3:8b`), so the codec uses a double colon. Ids
 * containing a literal `::` cannot be encoded and are rejected.
 */
export const DEPLOYMENT_KEY_SEPARATOR = "::"

/** Wildcard modelId for provider-only telemetry sites. */
export const DEPLOYMENT_MODEL_WILDCARD = "*"

function isEncodableSegment(segment: string): boolean {
  return segment.length > 0 && !segment.includes(DEPLOYMENT_KEY_SEPARATOR)
}

/**
 * Serialize a deployment identity to its store key
 * (`providerId::modelId[::keyId]`). Returns `null` when a segment is empty
 * or would corrupt the encoding (contains `::`).
 */
export function deploymentKeyOf(key: DeploymentKey): string | null {
  const { providerId, modelId, keyId } = key
  if (!isEncodableSegment(providerId) || !isEncodableSegment(modelId)) return null
  if (keyId !== undefined && !isEncodableSegment(keyId)) return null
  const base = `${providerId}${DEPLOYMENT_KEY_SEPARATOR}${modelId}`
  return keyId === undefined ? base : `${base}${DEPLOYMENT_KEY_SEPARATOR}${keyId}`
}

/**
 * Parse a store key back into its structured form. Returns `null` for
 * malformed input (wrong segment count or empty segments).
 */
export function parseDeploymentKey(raw: string): DeploymentKey | null {
  const parts = raw.split(DEPLOYMENT_KEY_SEPARATOR)
  if (parts.length < 2 || parts.length > 3) return null
  if (parts.some((p) => p.length === 0)) return null
  const [providerId, modelId, keyId] = parts
  return keyId === undefined ? { providerId, modelId } : { providerId, modelId, keyId }
}

/** Deployment key for a mapping entry (no keyId — entries are key-agnostic). */
export function deploymentKeyOfEntry(
  entry: Pick<ModelMappingEntry, "providerId" | "modelId">
): string | null {
  return deploymentKeyOf({ providerId: entry.providerId, modelId: entry.modelId })
}

/**
 * Provider-wildcard key (`providerId::*`) for telemetry call sites that do
 * not know the model. Aggregators treat it as one more deployment bucket
 * under the provider.
 */
export function wildcardDeploymentKey(providerId: string): string | null {
  return deploymentKeyOf({ providerId, modelId: DEPLOYMENT_MODEL_WILDCARD })
}

/** Extract just the providerId from a store key (fast path for aggregation). */
export function providerIdOfDeploymentKey(raw: string): string | null {
  return parseDeploymentKey(raw)?.providerId ?? null
}
