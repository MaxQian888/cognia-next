import {
  ProviderInferenceDefaults,
  ProviderConnectionParams,
  ModelInferenceParams,
} from "@cognia/provider-types/provider"

/**
 * Translate a provider's persisted inference configuration into the AI SDK v6
 * call-option shape (`ModelInferenceParams`) that the sidecar's ai-sdk
 * dispatcher spreads into `streamText`. Without this, every non-Anthropic turn
 * dropped the user's configured temperature / token cap / penalties because the
 * dispatcher hard-coded them to `undefined`.
 *
 * Pure + framework-agnostic so it can be unit-tested and reused by both the
 * chat send path (`build-options`) and the plugin AI surface.
 */

interface InferenceParamSource {
  inferenceDefaults?: ProviderInferenceDefaults
  connectionParams?: ProviderConnectionParams
  advancedParams?: Record<string, unknown>
}
/**
 * Build the AI SDK call-option params, omitting anything unset or malformed.
 * Returns `undefined` when nothing usable is configured so callers can avoid
 * attaching an empty object to the request.
 */
declare function buildModelInferenceParams(
  source: InferenceParamSource | undefined
): ModelInferenceParams | undefined

export { type InferenceParamSource, buildModelInferenceParams }
