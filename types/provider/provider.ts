/**
 * Minimal provider type stub for cognia-next.
 *
 * The Cognia source ships a full provider catalog (Anthropic, OpenAI,
 * Google, OpenRouter, …). cognia-next does not — its only AI runtime is
 * the bundled Anthropic SDK / Claude Code sidecar plus External Agents.
 * The External Agent code only needs the `ProviderName` symbol.
 */

export type ProviderName =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "ollama"
  | "auto"
  | string
