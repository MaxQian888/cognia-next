/**
 * Plugin SDK helper for OCR provider contributions.
 *
 * Pure typesafety pass-through for `manifest.ocrProviders[]` entries.
 */

import type { PluginOcrProviderDef } from "@cognia/plugin-contract/types/plugin/plugin-ocr"

export function defineOcrProvider(def: PluginOcrProviderDef): PluginOcrProviderDef {
  return def
}
