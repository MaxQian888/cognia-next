import { p as ModelMappingEntry } from "./auto-router-CU21j5Mo.js"
import "./provider.js"
import "./built-in-provider-catalog.js"
import "./bedrock.js"
import "./circuit-breaker.js"
import "./health-metrics.js"
import "./error-class.js"

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

/** Structured identity of a single deployment. */
interface DeploymentKey {
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
declare const DEPLOYMENT_KEY_SEPARATOR = "::"
/** Wildcard modelId for provider-only telemetry sites. */
declare const DEPLOYMENT_MODEL_WILDCARD = "*"
/**
 * Serialize a deployment identity to its store key
 * (`providerId::modelId[::keyId]`). Returns `null` when a segment is empty
 * or would corrupt the encoding (contains `::`).
 */
declare function deploymentKeyOf(key: DeploymentKey): string | null
/**
 * Parse a store key back into its structured form. Returns `null` for
 * malformed input (wrong segment count or empty segments).
 */
declare function parseDeploymentKey(raw: string): DeploymentKey | null
/** Deployment key for a mapping entry (no keyId — entries are key-agnostic). */
declare function deploymentKeyOfEntry(
  entry: Pick<ModelMappingEntry, "providerId" | "modelId">
): string | null
/**
 * Provider-wildcard key (`providerId::*`) for telemetry call sites that do
 * not know the model. Aggregators treat it as one more deployment bucket
 * under the provider.
 */
declare function wildcardDeploymentKey(providerId: string): string | null
/** Extract just the providerId from a store key (fast path for aggregation). */
declare function providerIdOfDeploymentKey(raw: string): string | null

export {
  DEPLOYMENT_KEY_SEPARATOR,
  DEPLOYMENT_MODEL_WILDCARD,
  type DeploymentKey,
  deploymentKeyOf,
  deploymentKeyOfEntry,
  parseDeploymentKey,
  providerIdOfDeploymentKey,
  wildcardDeploymentKey,
}
