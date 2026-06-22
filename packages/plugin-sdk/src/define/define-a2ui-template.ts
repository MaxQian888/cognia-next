/**
 * Plugin SDK helper for A2UI template contributions.
 *
 * Pure typesafety pass-through for `manifest.a2uiTemplates[]` entries.
 */

import type { A2UITemplateDef } from "@/types/plugin/plugin"

export function defineA2UITemplate(def: A2UITemplateDef): A2UITemplateDef {
  return def
}
