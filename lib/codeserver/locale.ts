/**
 * Maps the app's display language onto code-server's, and edits the `argv.json`
 * document that carries it.
 *
 * Why `argv.json` and not `settings.json`: VS Code's display language is a
 * *runtime argument*, not a setting — the "Configure Display Language" command
 * writes `{"locale": "…"}` into `argv.json` in the user-data folder, and the
 * workbench reads it only at startup. So a locale change needs a file this module
 * owns plus a restart of the instance, where a theme change needs neither.
 *
 * https://code.visualstudio.com/docs/getstarted/locales
 *
 * The language *pack* side (VS Code ships English only) is handled in Rust, in
 * `codeserver::process`: the pack has to be installed before the workbench boots,
 * so it runs inside `ensure` off the locale this module wrote.
 */
import type { AppLanguage } from "@cognia/agent-config-types"

import { stripJsonComments } from "@/lib/appearance/vscode-theme/parse-json"

/**
 * The app's language tag → VS Code's locale spelling.
 *
 * VS Code uses lowercase, hyphenated tags (`zh-cn`, `pt-br`); the app uses the
 * BCP-47 casing (`zh-CN`). Lowercasing is not a sufficient general rule (VS Code
 * has no `en-us` locale, only `en`), so the mapping is explicit for the languages
 * the app actually ships and falls back to a lowercased tag for anything added
 * later — which is right far more often than it is wrong, and the Rust side
 * refuses to guess a pack id for a locale it doesn't know.
 */
const APP_TO_VSCODE_LOCALE: Partial<Record<AppLanguage, string>> = {
  en: "en",
  "zh-CN": "zh-cn",
}

/** The VS Code locale that matches the app's active display language. */
export function vscodeLocaleForAppLanguage(language: AppLanguage | undefined): string {
  if (!language) return "en"
  return APP_TO_VSCODE_LOCALE[language] ?? language.toLowerCase()
}

/** Read the `locale` currently declared in an `argv.json` document. */
export function readRuntimeArgsLocale(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const locale = (parsed as Record<string, unknown>).locale
    if (typeof locale !== "string") return null
    return locale.trim() || null
  } catch {
    return null
  }
}

/**
 * Return `argv.json` text with `locale` set to `locale`, preserving every other
 * runtime argument the user or VS Code put there.
 *
 * Comments do not survive (we re-serialize as JSON), matching how the settings
 * writer behaves — but `enable-crash-reporter`, `disable-hardware-acceleration`
 * and friends do, which is what actually matters.
 */
export function withRuntimeArgsLocale(raw: string, locale: string): string {
  let existing: Record<string, unknown> = {}
  const trimmed = raw.trim()
  if (trimmed) {
    try {
      const parsed: unknown = JSON.parse(stripJsonComments(raw))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>
      }
    } catch {
      // Corrupt file — rewriting it is better than leaving the editor stuck in a
      // language the user changed away from.
    }
  }
  return `${JSON.stringify({ ...existing, locale }, null, 2)}\n`
}
