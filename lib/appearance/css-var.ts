import type { ThemeColors } from "@/types/plugin/plugin"
import { THEME_COLOR_KEYS } from "./vscode-theme/token-mapping"

/**
 * Convert a ThemeColors key (camelCase) to its CSS custom-property name (kebab).
 * `primaryForeground` → `--primary-foreground`. The mapping is a direct
 * camel→kebab transform; the `app/globals.css` variable names match.
 */
export function themeKeyToCssVar(key: keyof ThemeColors | string): string {
  // Use a positive lookbehind via the captured lowercase char so we never
  // match at position 0 — `Primary` would otherwise become `---primary`.
  const kebab = key.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
  return `--${kebab}`
}

export const CSS_VAR_KEYS: readonly string[] = THEME_COLOR_KEYS.map(themeKeyToCssVar)

// ----------------------------------------------------------------------------
// Sparse var/attr helpers shared by appearance appliers. All functions assume
// the caller has already verified `document` exists (i.e. they live inside a
// `useEffect`). We deliberately do NOT expose a hook that wraps `useEffect`
// with a caller-supplied deps array: React's `exhaustive-deps` rule cannot
// statically verify deps that aren't array literals, and the boilerplate we
// would avoid (~3 lines per applier) isn't worth a lint fight. Each applier
// owns its own `useEffect` with inline deps and calls the helpers below.
// ----------------------------------------------------------------------------

/**
 * Write a batch of CSS custom properties onto `target`. Skips undefined,
 * null, and empty-string values so callers can pass a sparse map without
 * pre-filtering. Returns the keys actually written so callers can clear
 * them in cleanup.
 */
export function applyCssVars(
  target: HTMLElement,
  vars: Record<string, string | number | undefined | null>
): string[] {
  const written: string[] = []
  for (const [key, raw] of Object.entries(vars)) {
    if (raw === undefined || raw === null) continue
    const value = typeof raw === "number" ? String(raw) : raw
    if (value === "") continue
    target.style.setProperty(key, value)
    written.push(key)
  }
  return written
}

/** Remove a list of CSS custom properties from `target`. */
export function removeCssVars(target: HTMLElement, keys: Iterable<string>): void {
  for (const key of keys) target.style.removeProperty(key)
}

/**
 * Set or clear a data-attribute on `target`. Empty / null / undefined values
 * remove the attribute entirely (no stale `data-foo=""` markers). Returns
 * `true` when the attribute is set, `false` when removed.
 */
export function setDataAttr(
  target: HTMLElement,
  name: string,
  value: string | null | undefined
): boolean {
  if (!value) {
    target.removeAttribute(name)
    return false
  }
  target.setAttribute(name, value)
  return true
}

/**
 * Apply a sparse map of data-attributes onto `target`. Returns the names
 * actually written, so callers can clear them in a subsequent pass.
 */
export function applyDataAttrs(
  target: HTMLElement,
  attrs: Record<string, string | null | undefined>
): string[] {
  const written: string[] = []
  for (const [name, value] of Object.entries(attrs)) {
    if (setDataAttr(target, name, value)) written.push(name)
  }
  return written
}

/** Remove a list of data-attributes from `target`. */
export function removeDataAttrs(target: HTMLElement, names: Iterable<string>): void {
  for (const name of names) target.removeAttribute(name)
}
