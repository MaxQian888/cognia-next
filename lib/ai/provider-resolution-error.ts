/**
 * A send path could not resolve a model provider.
 *
 * `resolveFeatureProvider` already answers *why* in machine-readable form — a
 * `code` (`missing_credential`, `provider_disabled`, `no_candidates`, …) and a
 * `nextAction` for the UI. Flattening that into `new Error(reason)` threw both
 * away, so the diagnostics funnel only had English prose to go on, matched
 * nothing, and the chat card said "Unexpected error" with no way forward for
 * the most common first-run failure there is: no provider set up yet.
 *
 * Leaf module on purpose: `lib/diagnostics` classifies with `instanceof`, and
 * importing the class from `provider-consumption` would drag every AI SDK
 * provider client into each bundle that can render a diagnostic.
 */

/**
 * The part of an `UnresolvedProvider` worth carrying. Kept structural (plain
 * strings) so it survives the `session_ended` event, which crosses a runtime
 * boundary as JSON, and so this module needs no import from the resolver.
 */
export interface ProviderResolutionFailure {
  reason: string
  /** The resolver's failure code, e.g. `"no_candidates"`. */
  code?: string
  /** What the resolver suggests the user do next, e.g. `"add_api_key"`. */
  nextAction?: string
  /** The provider the resolver tried last, when it tried one. */
  providerId?: string
}

export class ProviderResolutionError extends Error {
  readonly code: string | undefined
  readonly nextAction: string | undefined
  readonly providerId: string | undefined

  constructor(failure: ProviderResolutionFailure) {
    super(failure.reason || "No model provider is configured.")
    this.name = "ProviderResolutionError"
    this.code = failure.code
    this.nextAction = failure.nextAction
    this.providerId = failure.providerId
  }
}
