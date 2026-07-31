"use client"

import type { CustomCssScope } from "@/types/appearance"

const STYLE_ELEMENT_ID = "cognia-user-css"

/**
 * Scope root for "app"-scoped user CSS. Matches the `id="app"` wrapper mounted
 * in `app/layout.tsx`. `@scope (#app) { … }` limits the user's rules to the
 * application shell so they don't bleed into surfaces rendered outside it
 * (e.g. portalled overlays appended to <body>). Requires Chromium 118+
 * (Tauri WebView2 / WKWebView and recent Android System WebView all qualify).
 */
const APP_SCOPE_SELECTOR = "#app"

/**
 * Wrap sanitized CSS in `@scope` when the user picked the "app" scope. The
 * "global" scope returns the CSS untouched so it applies document-wide.
 */
function scopeCss(css: string, scope: CustomCssScope): string {
  if (scope === "global" || css.trim().length === 0) return css
  return `@scope (${APP_SCOPE_SELECTOR}) {\n${css}\n}`
}

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
 * `scope` controls whether the sanitized CSS is wrapped in `@scope (#app)`
 * (default "app" — limited to the application shell) or injected document-wide
 * ("global"). The returned `css`/`removedCount` always reflect the sanitized
 * (unwrapped) rules so callers can show an accurate "X rule(s) removed" count.
 *
 * Safe to call from a React effect on every settings change.
 */
export function applyUserCss(
  rawCss: string,
  enabled: boolean,
  scope: CustomCssScope = "app"
): SanitizationResult {
  if (typeof document === "undefined") {
    return { css: rawCss, removedCount: 0 }
  }
  const existing = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null
  if (!enabled || rawCss.trim().length === 0) {
    if (existing) existing.remove()
    return { css: "", removedCount: 0 }
  }
  const sanitized = sanitizeUserCss(rawCss)
  const injected = scopeCss(sanitized.css, scope)
  let tag = existing
  if (!tag) {
    tag = document.createElement("style")
    tag.id = STYLE_ELEMENT_ID
    // Append at the very end of <head> so the user's rules win against
    // the framework's stylesheets — same precedence rule any custom-CSS
    // feature (VSCode, Obsidian, etc.) uses.
    document.head.appendChild(tag)
  }
  if (tag.textContent !== injected) {
    tag.textContent = injected
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
