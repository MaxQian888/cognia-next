import { parse, walk } from "css-tree"
import type { CssNode } from "css-tree"
import { resolveUrl } from "./url-resolver.js"

export interface CssAssetRef {
  url: string
  type: "font" | "img" | "css" | "other"
}

function classifyCssUrl(urlStr: string): CssAssetRef["type"] {
  const cleanUrl = urlStr.split("?")[0].split("#")[0].toLowerCase()
  if (
    cleanUrl.endsWith(".woff") ||
    cleanUrl.endsWith(".woff2") ||
    cleanUrl.endsWith(".ttf") ||
    cleanUrl.endsWith(".otf") ||
    cleanUrl.endsWith(".eot")
  ) {
    return "font"
  }
  if (cleanUrl.endsWith(".css")) {
    return "css"
  }
  const imgExts = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico"]
  if (imgExts.some((e) => cleanUrl.endsWith(e))) {
    return "img"
  }
  // Heuristic: check path segments for common keywords when URL has no extension
  if (!cleanUrl.includes(".")) {
    const segments = cleanUrl.split("/")
    const last = segments[segments.length - 1] || ""
    if (/font|icon|glyph/i.test(last)) return "font"
    if (/img|image|pict/i.test(last)) return "img"
  }
  return "other"
}

export function extractCssAssets(css: string, baseUrl: string): CssAssetRef[] {
  const refs: CssAssetRef[] = []
  let ast
  try {
    ast = parse(css, { positions: false })
  } catch {
    return refs
  }

  walk(ast, (node: CssNode) => {
    if (node.type === "Url") {
      const urlStr = node.value
      if (urlStr) {
        const resolved = resolveUrl(urlStr, baseUrl)
        if (resolved) {
          refs.push({ url: resolved, type: classifyCssUrl(resolved) })
        }
      }
    }

    if (node.type === "Atrule" && node.name === "import") {
      const prelude = node.prelude
      if (prelude) {
        let importUrl: string | null = null
        walk(prelude, (child: CssNode) => {
          if (child.type === "String" && !importUrl) {
            importUrl = child.value
          }
          if (child.type === "Url" && !importUrl) {
            importUrl = child.value
          }
        })
        if (importUrl) {
          const resolved = resolveUrl(importUrl, baseUrl)
          if (resolved) {
            refs.push({ url: resolved, type: "css" })
          }
        }
      }
    }
  })

  return refs
}

export function rewriteCssUrls(css: string, urlMap: Map<string, string>): string {
  let result = css
  for (const [original, replacement] of urlMap) {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    result = result.replace(new RegExp(escaped, "g"), replacement)
  }
  return result
}
