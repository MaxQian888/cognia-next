/**
 * Plugin configuration default-seeding.
 *
 * VS Code-style declarative config (`manifest.configSchema`) carries per-
 * property `default`s, and the manifest may also carry a `defaultConfig` blob.
 * For a plugin's `ctx.configuration.get(key)` to return a value before the user
 * ever opens the settings form, those defaults must be materialised into the
 * persisted config row at enable time. This module computes the seeded config;
 * the manager persists it.
 *
 * Precedence (highest first): persisted user value → `manifest.defaultConfig` →
 * `configSchema.properties[key].default`. A persisted value is NEVER overwritten.
 */

import type { PluginConfigSchema, PluginManifest } from "@/types/plugin"

/** Per-property `default`s from a schema (properties without a default are skipped). */
export function computeConfigDefaults(schema?: PluginConfigSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!schema?.properties) return out
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop && Object.prototype.hasOwnProperty.call(prop, "default")) {
      out[key] = prop.default
    }
  }
  return out
}

/**
 * Merge schema + `defaultConfig` defaults under any keys the persisted config
 * does not already set. Returns the SAME `current` reference when nothing needs
 * seeding (so callers can skip a redundant DB write).
 */
export function seedPluginConfigDefaults(
  manifest: PluginManifest,
  current: Record<string, unknown> | undefined
): Record<string, unknown> {
  const base = current ?? {}
  // schema defaults are the lowest precedence; defaultConfig overrides them.
  const seedCandidates: Record<string, unknown> = {
    ...computeConfigDefaults(manifest.configSchema),
    ...(manifest.defaultConfig ?? {}),
  }

  let changed = false
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(seedCandidates)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = value
      changed = true
    }
  }

  return changed ? merged : (current ?? merged)
}
