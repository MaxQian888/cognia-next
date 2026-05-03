/**
 * AI hooks barrel.
 *
 * Cognia exposes a richer set of AI runtime hooks (provider manager,
 * routing engine, ollama lifecycle, etc.). The provider port deferred
 * those, so cognia-next ships a compatible-shape `useOllama` hook that
 * delegates to the local-provider service over plain HTTP.
 */

export * from "./use-ollama"
