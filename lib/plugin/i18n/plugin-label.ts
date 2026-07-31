export interface PluginLabelTranslator {
  (key: string): string
  has?: (key: string) => boolean
}

/**
 * Resolve a plugin-owned `*Key` against the loaded plugin bundle, falling back
 * to the manifest's literal label. Use this wherever the caller always has a
 * label to show; `resolveOptionalPluginLabel` is the variant for surfaces where
 * "no label" is a legitimate outcome.
 */
export function resolvePluginLabel(
  translator: PluginLabelTranslator,
  pluginId: string,
  key: string | undefined,
  fallback: string
): string {
  return resolveOptionalPluginLabel(translator, pluginId, key, fallback)
}

/**
 * Same `*Key`-before-literal precedence, for labels the manifest may omit
 * entirely (an optional section title, say).
 *
 * The distinction matters: a caller that guards on the bare literal
 * (`entry.title && <h3>{resolve(...)}</h3>`) never reaches the translator for a
 * `{ titleKey, title: undefined }` entry, which is exactly the localized-only
 * manifest the key was added for. Guard on this function's result instead —
 * `undefined` means neither the key nor a literal produced anything.
 *
 * The return type follows the fallback's: pass a `string` and you get a
 * `string` back, which is what lets `resolvePluginLabel` delegate here without
 * a `?? fallback` that could never fire.
 */
export function resolveOptionalPluginLabel<F extends string | undefined>(
  translator: PluginLabelTranslator,
  pluginId: string,
  key: string | undefined,
  fallback: F
): string | F {
  if (!key) return fallback
  const fullKey = `plugin.${pluginId}.${key}`
  return translator.has?.(fullKey) ? translator(fullKey) : fallback
}
