/**
 * Web Clone — message helpers.
 *
 * The strings themselves live in plugin.json (`i18n.locales`, flat unprefixed
 * keys); the manager registers that bundle before `activate()` runs, so the
 * command translates through `ctx.i18n.t`. This module only types the keys and
 * provides the English translator the exported pure helpers default to, read
 * from the same bundle — there is no second copy of any string.
 */

import manifestJson from "../plugin.json"

const EN: Record<string, string> = manifestJson.i18n.locales.en

export type WebCloneMessageKey = keyof typeof manifestJson.i18n.locales.en

export type WebCloneTranslate = (
  key: WebCloneMessageKey | string,
  params?: Record<string, string | number | boolean>
) => string

/** Interpolate `{name}` params into a message template; unknown names stay literal. */
export function interpolateWebCloneMessage(
  template: string,
  params?: Record<string, string | number | boolean>
): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  )
}

/** English translator over plugin.json's own bundle (locale → en → key). */
export const englishWebCloneT: WebCloneTranslate = (key, params) =>
  interpolateWebCloneMessage(EN[key] ?? key, params)
