import type { ThemeColors } from "@/types/plugin/plugin"
import { THEME_TOKEN_CSS_VARS, themeTokenCssVar } from "./theme-token-catalog"

/**
 * Convert a ThemeColors key to its CSS custom-property name.
 *
 * A plain camel→kebab transform was right for the original 27 tokens and wrong
 * for 18 of the 56: it turns `chart1` into `--chart1` and `workflowTrigger` into
 * `--workflow-trigger`, neither of which any stylesheet reads. The real names
 * are declared per-token in `theme-token-catalog.ts`; the transform survives
 * only as the fallback for keys the catalog does not own (a plugin's extra
 * `cssVariables`, an unknown key in an imported JSON).
 */
export function themeKeyToCssVar(key: keyof ThemeColors | string): string {
  return themeTokenCssVar(key)
}

/** Every custom property a theme owns — the applier's write and clear list. */
export const CSS_VAR_KEYS: readonly string[] = THEME_TOKEN_CSS_VARS

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
