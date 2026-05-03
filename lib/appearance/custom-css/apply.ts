"use client"

const STYLE_ELEMENT_ID = "cognia-user-css"

/**
 * Patterns we strip from user CSS before injection. Goal: keep "valid CSS
 * the renderer would accept" but reject anything that talks to the network
 * (privacy + tracking risk) or escapes the document (e.g. import-side
 * effects). The user's local CSS still has full rendering power inside
 * the page; what we cut is only fetch-the-internet hooks.
 *
 * Anyone determined to bypass this can still use clever escapes — the
 * filter is a safety rail, not a sandbox. We document this explicitly in
 * the Advanced tab UI.
 */
const REMOTE_URL_RE = /url\(\s*["']?\s*(?:https?:|\/\/)/gi
const IMPORT_RE = /@import\s+(?:url\()?["']?\s*(?:https?:|\/\/)[^;]*;?/gi

export interface SanitizationResult {
  css: string
  removedCount: number
}

/**
 * Strip remote URLs / @import statements. The returned `css` is what gets
 * written into the `<style>` tag; `removedCount` lets the UI display a
 * "X rule(s) were removed" warning.
 */
export function sanitizeUserCss(input: string): SanitizationResult {
  let removed = 0
  let css = input
  css = css.replace(IMPORT_RE, () => {
    removed += 1
    return ""
  })
  css = css.replace(REMOTE_URL_RE, () => {
    removed += 1
    return "url("
  })
  return { css, removedCount: removed }
}

/**
 * Idempotent — looks up the singleton style tag (creating it on first
 * call) and updates its content. Pass `enabled: false` to remove the tag
 * entirely so the user's CSS stops affecting the document immediately.
 *
 * Safe to call from a React effect on every settings change.
 */
export function applyUserCss(rawCss: string, enabled: boolean): SanitizationResult {
  if (typeof document === "undefined") {
    return { css: rawCss, removedCount: 0 }
  }
  const existing = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (!enabled || rawCss.trim().length === 0) {
    if (existing) existing.remove()
    return { css: "", removedCount: 0 }
  }
  const sanitized = sanitizeUserCss(rawCss)
  let tag = existing
  if (!tag) {
    tag = document.createElement("style")
    tag.id = STYLE_ELEMENT_ID
    // Append at the very end of <head> so the user's rules win against
    // the framework's stylesheets — same precedence rule any custom-CSS
    // feature (VSCode, Obsidian, etc.) uses.
    document.head.appendChild(tag)
  }
  if (tag.textContent !== sanitized.css) {
    tag.textContent = sanitized.css
  }
  return sanitized
}

/** Remove the injected style tag if it's present. Useful for unmount cleanup. */
export function removeUserCss(): void {
  if (typeof document === "undefined") return
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (existing) existing.remove()
}

/** Exported for tests. */
export const __INTERNALS__ = { STYLE_ELEMENT_ID }
