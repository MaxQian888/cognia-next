// Standalone (BYOK) web search → cited answer — app binding (ADR-0068 E2).
//
// The framework-agnostic pipeline lives in `@cognia/web-search`; this module
// keeps the historical `@/lib/search/standalone-answer` specifier stable and
// supplies the app's `StandaloneAnswerDeps`:
//  - config from the settings store (search-provider keys + result cap);
//  - the answer-synthesis model through the same standalone transport seam
//    the BYOK chat engine uses: `resolveStandaloneProvider` (provider+key
//    from local settings) + `createFeatureProviderModel` with
//    `getStreamingFetch()` (native WebView fetch, bypasses CapacitorHttp
//    buffering) and `browserDirectHeaders()` (the Anthropic browser-direct
//    CORS opt-in);
//  - the synthesis call's generation seam: with Router + Fusion's
//    `utilityLedger` surface on, the call is reserved and settled on the
//    CallLedger (`lib/ai/ledgered-generation-seam.ts`, ADR-0188 D27). Off, no
//    seam is injected and the call is exactly what it was.

// Side-effect: registers the settings-store usage reporter with the package
// core. The core's search() (which this pipeline calls internally) records
// per-provider usage through that seam, so a session whose only search
// surface is /search must still load the registration.
import "./search-service"

import {
  runStandaloneSearchAnswer as runStandaloneSearchAnswerCore,
  type RunStandaloneSearchParams,
  type StandaloneSearchAnswer,
} from "@cognia/web-search/standalone-answer"

import { ledgeredGenerationSeam } from "@/lib/ai/ledgered-generation-seam"
import { createFeatureProviderModel } from "@/lib/ai/provider-consumption"
import { resolveStandaloneProvider } from "@/lib/ai/chat/resolve-standalone-provider"
import { browserDirectHeaders, getStreamingFetch } from "@/lib/runtime/streaming-fetch"
import { searchWithAppSettings } from "./configured-search"
import { redactText } from "@cognia/redact"
import { wrapUntrustedContent } from "@/lib/web/untrusted-content"
import { useSettingsStore } from "@/stores/settings"

export {
  StandaloneSearchError,
  buildAnswerPrompt,
  type RunStandaloneSearchParams,
  type StandaloneAnswerDeps,
  type StandaloneSearchAnswer,
  type StandaloneSearchErrorCode,
} from "@cognia/web-search/standalone-answer"

/** The utility-ledger feature id of the answer synthesis; the package appends its stage. */
export const STANDALONE_SEARCH_ANSWER_FEATURE = "standalone-search-answer"

/**
 * Run a standalone web search and synthesize a cited answer with the app's
 * settings-store config and BYOK model resolution. Same contract as the core:
 * throws `StandaloneSearchError` with a stable `code` for every failure mode.
 */
export async function runStandaloneSearchAnswer(
  params: RunStandaloneSearchParams
): Promise<StandaloneSearchAnswer> {
  // The provider `resolveModel` resolved for this call, so the ledger prices the
  // very deployment the synthesis runs on. Scoped to this one call.
  let resolvedProviderId: string | null = null
  return runStandaloneSearchAnswerCore(
    {
      ...params,
      searchImpl:
        params.searchImpl ?? ((query, options) => searchWithAppSettings(query, { options })),
    },
    {
      getConfig: () => {
        const settings = useSettingsStore.getState().settings
        return {
          providerSettings: settings?.searchProviders,
          maxResults: settings?.searchMaxResults,
          maxRetries: settings?.searchMaxRetries,
        }
      },
      resolveModel: () => {
        const settings = useSettingsStore.getState().settings
        const resolution = resolveStandaloneProvider(settings)
        if (resolution.kind !== "resolved") return null
        resolvedProviderId = resolution.providerId
        return createFeatureProviderModel(resolution, {
          fetch: getStreamingFetch(),
          headers: browserDirectHeaders(resolution.protocol),
        })
      },
      resolveGenerate: () =>
        resolvedProviderId === null
          ? undefined
          : ledgeredGenerationSeam({
              binding: {
                surface: "utilityLedger",
                origin: "utility",
                featureId: STANDALONE_SEARCH_ANSWER_FEATURE,
                providerId: resolvedProviderId,
                workspaceId: null,
              },
              settings: useSettingsStore.getState().settings,
            }),
      sanitizeText: (text) => redactText(text).redacted,
      wrapUntrustedContent,
    }
  )
}
