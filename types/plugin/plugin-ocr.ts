/**
 * Type contracts for plugin-contributed OCR providers.
 *
 * Plugins extend `lib/ocr/` by registering a custom `OcrProvider` either:
 * 1. **Declaratively** via `manifest.ocrProviders[]` — the host's
 *    `lib/plugin/bridge/ocr-providers-bridge.ts` dynamic-imports each `entry`
 *    on plugin enable and calls the named `export` to produce the provider.
 * 2. **Imperatively** via `ctx.ocr.registerProvider(provider)` in
 *    `activate()` — useful when the provider needs state from `ctx.config`
 *    or `ctx.secrets`.
 *
 * Both paths funnel through the same `lib/ocr/registry.ts:registerOcrProvider`
 * singleton so the auto-router and Dexie cache see the new provider exactly
 * like a built-in. Registration is auto-revoked on plugin disable.
 *
 * The `provider.ocr` runtime point lives in
 * `lib/plugin/contracts/plugin-points.ts:CANONICAL_RUNTIME_POINTS` and is
 * permission-gated by `network:fetch` (most providers reach a cloud API).
 *
 * See ADR-0026.
 */

import type { OcrProvider } from "@/types/ocr"
import type { PluginContributionBackend } from "@/types/plugin/plugin"

/**
 * One OCR provider contribution in `manifest.ocrProviders[]`.
 *
 * The host loads the provider lazily — `entry` is dynamic-imported only when
 * the OCR registry first needs a provider not yet resolved. Plugins should
 * therefore avoid heavy module-level work in the entry file.
 */
export interface PluginOcrProviderDef {
  /**
   * Provider id, unprefixed. The host prefixes with the plugin id at
   * registration time (`<pluginId>:<id>`) so two plugins cannot collide.
   */
  id: string
  /**
   * Human-readable name shown in OCR settings and the auto-router debug panel.
   */
  label: string
  /**
   * Which runtime owns this provider's factory. Omit to inherit the plugin
   * type (`python` plugins default to `"python"`); declaring `entry` pins it
   * to `"js"`. See {@link PluginContributionBackend}.
   */
  backend?: PluginContributionBackend
  /**
   * Relative path inside the plugin install root to the module that exports
   * the factory. Validated by `lib/plugin/core/validation.ts` against path
   * traversal (no `..`, no absolute paths, no NUL bytes).
   *
   * Required for JS-backed providers; omitted for python-backed ones, which
   * resolve through the `plugin_python_call` seam instead of a JS module.
   */
  entry?: string
  /**
   * Named export on the entry module — must resolve to a
   * `PluginOcrProviderFactory` at runtime. Required for JS-backed providers.
   */
  export?: string
  /**
   * Free-text description displayed in the provider picker UI.
   */
  description?: string
}

/**
 * Runtime factory shape the host calls after dynamic-importing `entry`.
 * Returns a fully constructed `OcrProvider` (or a Promise of one). The
 * factory receives a small context object so it can read its own config
 * and store secrets without re-implementing the plumbing in every plugin.
 */
export type PluginOcrProviderFactory = (
  ctx: PluginOcrProviderFactoryContext
) => OcrProvider | Promise<OcrProvider>

export interface PluginOcrProviderFactoryContext {
  /** The provider id (already prefixed by `<pluginId>:`). */
  providerId: string
  /** The plugin id that owns this provider. */
  pluginId: string
  /** Read a config value from the plugin's settings store. */
  getConfig<T = unknown>(key: string): T | undefined
  /** Read a secret from the OS keyring (returns undefined if absent). */
  getSecret(key: string): Promise<string | undefined>
}

/**
 * Handle returned by `ctx.ocr.registerProvider(...)`. Calling `unregister()`
 * is idempotent — the host already unregisters on plugin disable.
 */
export interface PluginOcrRegistration {
  /** Prefixed provider id (`<pluginId>:<id>`). */
  providerId: string
  unregister(): void
}
