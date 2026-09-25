/**
 * Plugin i18n bundle access (ADR-0026 §5 §D). The authoritative strings live in
 * `plugin.json` `i18n.locales` — the manager merges them into the host registry
 * under `plugin.cognia-presentations.*` on enable and tears them down on
 * disable, so activate() does not need an imperative `registerTranslations`
 * pass. Runtime code translates through `ctx.i18n.t` (renderer, importer) or
 * `usePluginTranslations` (the result card); this module re-exports the bundle
 * for the en/zh-CN parity test and offers the same locale → English → key
 * lookup for code paths that hold no context.
 */

import manifestJson from "../plugin.json"

export type PresentationTranslate = (key: string, vars?: Record<string, string | number>) => string

export const I18N_MESSAGES: Record<string, Record<string, string>> = (
  manifestJson as { i18n?: { locales?: Record<string, Record<string, string>> } }
).i18n?.locales ?? {}

/** Locale-fallback translator for contexts that cannot reach `ctx.i18n.t`. */
export function translate(
  locale: string,
  key: string,
  vars?: Record<string, string | number>
): string {
  let value = I18N_MESSAGES[locale]?.[key] ?? I18N_MESSAGES.en?.[key] ?? key
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replace(`{${name}}`, String(replacement))
    }
  }
  return value
}
