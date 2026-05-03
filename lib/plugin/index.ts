/**
 * Plugin runtime entry point.
 *
 * This module is a thin barrel — it re-exports the canonical plugin
 * runtime surfaces from their respective modules. The real
 * `PluginManager` is instantiated through
 * `getPluginManager()` / `initializePluginManager()` in
 * `lib/plugin/core/manager.ts`. The canonical manifest validator lives
 * in `lib/plugin/core/validation.ts`. The hook dispatchers live in
 * `lib/plugin/messaging/hooks-system.ts`.
 */

export { getPluginEventHooks, getPluginLifecycleHooks } from "./messaging/hooks-system"

export type { PluginEventHooks, PluginLifecycleHooks } from "./messaging/hooks-system"

export { validatePluginManifest } from "./core/validation"

export type {
  ValidationResult,
  ValidationError,
  ManifestDiagnostic,
  ManifestValidationOptions,
  ConfigValidationResult,
} from "./core/validation"
