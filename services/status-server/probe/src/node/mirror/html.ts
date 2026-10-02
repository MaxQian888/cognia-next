/**
 * Runtime `<meta>` injection for the exported status page. The page reads
 * `<meta name="cognia-status-runtime">` (lib/status/config.ts) to learn it is
 * a read-only mirror with a same-origin API, which disables every consent
 * write regardless of what a copied snapshot advertises.
 */

import { STATUS_API_PATH, STATUS_RUNTIME_META_NAME } from "../../../../../../lib/status/config"

export const MIRROR_RUNTIME_CONTENT = JSON.stringify({ mode: "mirror", apiBase: STATUS_API_PATH })

const META_TAG = `<meta name="${STATUS_RUNTIME_META_NAME}" content='${MIRROR_RUNTIME_CONTENT}'>`

const EXISTING_META = new RegExp(
  `<meta\\b[^>]*\\bname\\s*=\\s*["']?${STATUS_RUNTIME_META_NAME}["']?[^>]*>`,
  "gi"
)

/** Replace any existing runtime meta, or insert one at the top of `<head>`. */
export function injectRuntimeMeta(html: string): string {
  if (EXISTING_META.test(html)) {
    EXISTING_META.lastIndex = 0
    let replaced = false
    // Keep exactly one tag even if a build emitted duplicates.
    return html.replace(EXISTING_META, () => {
      if (replaced) return ""
      replaced = true
      return META_TAG
    })
  }
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return `${html.slice(0, at)}${META_TAG}${html.slice(at)}`
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype ? doctype[0].length : 0
  return `${html.slice(0, at)}<head>${META_TAG}</head>${html.slice(at)}`
}
