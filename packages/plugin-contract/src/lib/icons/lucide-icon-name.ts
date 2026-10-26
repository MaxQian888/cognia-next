/**
 * Normalizes a plugin-declared icon name to the key `lucide-react` actually
 * exports.
 *
 * `lucide-react`'s `icons` map is keyed in PascalCase (`FileText`), but the
 * plugin contract used to publish a kebab-case allowlist
 * (`PLUGIN_CONTEXT_PANEL_ICONS` = `"file-text"`, `"panel-right"`, …). When that
 * constant was replaced by a direct lookup against `icons`, every already
 * installed third-party plugin using the documented spelling started failing
 * manifest validation outright. This is the one place that bridge lives, so
 * validation and rendering agree on what a name means.
 *
 * Deliberately pure and dependency-free — `lib/plugin/core/validation.ts` sits
 * on the plugin-runtime chunk that ships to the browser and Capacitor shells,
 * and must not gain a second import of the ~1500-icon barrel just to spell a
 * name.
 */

/** Matches a well-formed kebab-case name: lowercase segments joined by `-`. */
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * `"file-text"` → `"FileText"`, `"volume-2"` → `"Volume2"`.
 *
 * Anything that is not kebab-case is returned untouched — a name that is
 * already PascalCase is the common case, and a malformed one should reach the
 * validator as the author wrote it so the error names what they typed.
 */
export function toLucideIconName(name: string): string {
  if (!KEBAB_CASE.test(name)) return name
  return name
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("")
}

/** True when `name` only resolves after normalization — i.e. it is the legacy spelling. */
export function isLegacyKebabIconName(
  name: string,
  isKnown: (candidate: string) => boolean
): boolean {
  return !isKnown(name) && isKnown(toLucideIconName(name))
}
