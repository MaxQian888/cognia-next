/**
 * Plugin SDK helper for declarative configuration (`manifest.configSchema`).
 *
 * Pure typesafety pass-through — wrapping a schema in `defineConfiguration()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `PluginConfigSchema` (VS Code `contributes.configuration`-style:
 * typed properties with defaults, enums, `order`, `markdownDescription`, …).
 * The host auto-renders the settings form and exposes the values at runtime via
 * `ctx.configuration`.
 */

import type { PluginConfigSchema } from "@/types/plugin"

export function defineConfiguration(schema: PluginConfigSchema): PluginConfigSchema {
  return schema
}
