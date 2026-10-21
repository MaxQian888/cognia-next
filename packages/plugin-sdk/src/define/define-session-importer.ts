/**
 * Plugin SDK helper for the `session-importer` capability (ADR-0062).
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineSessionImporter()` narrows the shape to `PluginSessionImporterDef`
 * (id + label + lazy `entry`/`export` factory path) at authoring time.
 */

import type { PluginSessionImporterDef } from "@cognia/plugin-contract/types/plugin/index"

export function defineSessionImporter(def: PluginSessionImporterDef): PluginSessionImporterDef {
  return def
}
