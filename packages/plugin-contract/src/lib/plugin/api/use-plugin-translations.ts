/**
 * The plugin contract's share of `lib/plugin/api/use-plugin-translations.ts`, which re-exports these.
 */
import type { TranslationParams } from "../../../types/plugin/plugin"

export type PluginTranslate = (key: string, params?: TranslationParams) => string
