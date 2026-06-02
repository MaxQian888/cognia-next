// Third-party relay endpoint preset (Anthropic + Codex only).
//
// A `ProviderPreset` overrides the provider's default base URL and optionally
// adds custom headers. Mirrors `subscription::preset::ProviderPreset` in Rust.

/** Provider preset — Anthropic + Codex only. Rejected for OpenCode. */
export interface ProviderPreset {
  /** UUIDv7. */
  id: string
  /** User-facing alias ("AWS Bedrock", "Azure OpenAI", "Custom proxy"). */
  label: string
  /** Base URL the provider's HTTP client targets instead of the default. */
  baseUrl: string
  /** Optional extra headers added on every request. */
  extraHeaders?: Record<string, string>
  /**
   * Provenance: the `PresetTemplate.templateId` this preset was instantiated
   * from (the built-in catalog id, e.g. "bedrock"). `undefined` = pure custom.
   * Used to pick a balance-query adapter and to badge the row in the UI.
   */
  templateId?: string
  /**
   * Logical-role → physical-model mapping applied via env at sidecar spawn.
   * Keys: `"default"` (→ ANTHROPIC_MODEL / OPENAI_MODEL) and `"fast"`
   * (→ ANTHROPIC_SMALL_FAST_MODEL). Empty/absent = no override.
   */
  modelMapping?: Record<string, string>
}
