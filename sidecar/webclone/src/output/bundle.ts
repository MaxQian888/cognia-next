import { writeFileSync, mkdirSync } from "node:fs"
import { join, extname, relative, resolve } from "node:path"
import { type Asset, type SnapshotOptions } from "../types.js"

function prettyPrintHtml(html: string): string {
  const indentStr = "  "
  const lines: string[] = []

  const result = html
    .replace(/>\s*</g, ">\n<") // Add newline between tags
    .replace(/\n\s+/g, "\n") // Remove existing whitespace

  let currentIndent = 0
  for (const line of result.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Close tags decrease indent
    if (trimmed.startsWith("</")) {
      currentIndent = Math.max(0, currentIndent - 1)
    }

    lines.push(indentStr.repeat(currentIndent) + trimmed)

    // Self-closing or empty tags don't change indent
    if (trimmed.startsWith("<") && !trimmed.startsWith("</") && !trimmed.endsWith("/>")) {
      // Open tags increase indent (unless they close on the same line)
      if (!trimmed.includes("</")) {
        currentIndent++
      }
    }
  }

  return lines.join("\n")
}

function assetCategory(type: string): string {
  const map: Record<string, string> = {
    css: "css",
    js: "js",
    img: "img",
    font: "fonts",
    media: "data",
  }
  return map[type] || "data"
}

/** Escape a string for use as a CSS attribute selector value (inside `[attr="..."]) */
function escCssAttr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Escape a URL string for use in a regex — safe for literal URL matching in srcset replacement */
function escRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function safeJoin(base: string, target: string): string | null {
  const resolvedBase = resolve(base)
  const resolved = resolve(resolvedBase, target)
  const normalizedBase = resolvedBase.replace(/\\/g, "/")
  const normalizedResolved = resolved.replace(/\\/g, "/")
  if (!normalizedResolved.startsWith(normalizedBase)) return null
  return resolved
}

/** MIME → extension mapping */
function extnameFromMime(mime: string): string | null {
  const map: Record<string, string> = {
    "text/css": ".css",
    "application/javascript": ".js",
    "text/javascript": ".js",
    "application/x-javascript": ".js",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "image/x-icon": ".ico",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "font/ttf": ".ttf",
    "font/opentype": ".otf",
  }
  return map[mime] || null
}

/**
 * Classify an asset URL and produce a safe filename.
 * Priority: Content-Type → URL path semantics → fallback.
 */
function classifyAssetFilename(url: string, mime: string, index: number): string {
  try {
    const u = new URL(url)
    const pathname = u.pathname.replace(/^\/+/, "") || "index"

    // 1. Content-Type inference extension name
    const extFromMime = extnameFromMime(mime)
    const existingExt = extname(pathname)
    if (extFromMime && !existingExt) {
      return pathname + extFromMime
    }
    if (extFromMime && existingExt && existingExt !== extFromMime) {
      // The file has an extension but differs from, For example,js files are not treated text .html.
      return pathname + extFromMime
    }

    // 2. Handle paths with query parameters like /gtag/js?id=xxx without extension
    const lastSegment = pathname.split("/").pop() || "index"
    const extFromUrl = extname(lastSegment)
    if (!extFromUrl && u.search) {
      // As /gtag/js?id=xxx → → /gtagtag.js
      const base = lastSegment.length < 10 ? `asset_${index}` : lastSegment
      // According to MIME, add a supplemental extension
      if (extFromMime) return base + extFromMime
      // Common path segment path inference
      if (lastSegment === "js" || lastSegment === "script") return base + ".js"
      if (lastSegment === "css" || lastSegment === "style") return base + ".css"
      return base + ".bin"
    }

    // 3. Existing extension
    if (existingExt) return pathname

    // 4. No file extension, query parameters → may be a route path
    return pathname || `asset_${index}`
  } catch {
    return `asset_${index}${extname(url.split("?")[0]) || ".bin"}`
  }
}

/**
 * Determine if a URL represents a route path (i.e. produces an HTML page).
 * Strict check: pathname has no extension AND last segment is not a short filename-like word.
 */
function isRoutePath(url: string): boolean {
  try {
    const u = new URL(url)
    const pathname = u.pathname.replace(/\/+$/, "")
    const ext = extname(pathname)
    if (ext) return false // Has extension → File

    // Check the last path segment
    const lastSegment = pathname.split("/").pop() || ""
    // Has query parameters and the last part is shorter → Likely an API or file (e.g., /gtag/js?id=xxx)
    if (lastSegment && lastSegment.length < 10 && u.search) return false
    // No query parameters → Route path
    return true
  } catch {
    return false
  }
}

function routeToIndexPath(url: string, index: number): string {
  try {
    const u = new URL(url)
    const pathname = u.pathname.replace(/^\/+/, "") || "index"
    return join(pathname, "index.html")
  } catch {
    return `route_${index}/index.html`
  }
}

export function assembleBundle(
  document: Document,
  assets: Asset[],
  options: SnapshotOptions
): void {
  const outDir = options.output
  const assetsDir = join(outDir, "assets")
  const assetMap = new Map<string, string>()

  mkdirSync(assetsDir, { recursive: true })

  for (let i = 0; i < assets.length; i++) {
    const a = assets[i]
    if (a.status !== "fetched") continue

    const cat = assetCategory(a.type)
    const catDir = join(assetsDir, cat)
    mkdirSync(catDir, { recursive: true })

    let fn
    if (isRoutePath(a.originUrl)) {
      fn = routeToIndexPath(a.originUrl, i)
    } else {
      fn = classifyAssetFilename(a.originUrl, a.mime, i)
    }

    // Path traversal protection
    const safeLocalPath = safeJoin(catDir, fn)
    if (!safeLocalPath) {
      a.status = "failed"
      a.error = "Path traversal attempt blocked"
      continue
    }

    const relPath = relative(outDir, safeLocalPath).replace(/\\/g, "/")

    a.localPath = safeLocalPath
    assetMap.set(a.originUrl, relPath)
  }

  for (const a of assets) {
    if (a.status !== "fetched") continue
    const relPath = assetMap.get(a.originUrl)
    if (!relPath) continue

    // Use data-origin-url (set by html-parser with resolved URL) to locate elements,
    // because DOM attributes (src/href) still hold raw paths (e.g. "/_nuxt/...")
    // while a.originUrl is the resolved absolute URL.
    const els = [...document.querySelectorAll(`[data-origin-url="${escCssAttr(a.originUrl)}"]`)]
    for (const el of els) {
      const tag = el.tagName.toLowerCase()
      if (tag === "link") {
        el.setAttribute("href", relPath)
      } else if (
        tag === "script" ||
        tag === "img" ||
        tag === "source" ||
        tag === "video" ||
        tag === "audio"
      ) {
        el.setAttribute("src", relPath)
      }

      // Rewrite URLs inside srcset attribute (responsive images, picture elements)
      if ((tag === "img" || tag === "source") && el.hasAttribute("srcset")) {
        const srcset = el.getAttribute("srcset")
        if (srcset) {
          // srcset format: "url descriptor, url descriptor, ..."
          // e.g. "img/hero-1x.jpg 1x, img/hero-2x.jpg 2x"
          const replaced = srcset.replace(
            // Match the origin URL in any descriptor position
            // The URL may have been percentage-encoded in srcset vs raw in originUrl
            new RegExp(escRegex(a.originUrl), "g"),
            relPath
          )
          el.setAttribute("srcset", replaced)
        }
      }
    }

    // Rewrite <a href> for route-to-index mapping
    if (isRoutePath(a.originUrl)) {
      const anchors = [...document.querySelectorAll(`a[href="${escCssAttr(a.originUrl)}"]`)]
      for (const el of anchors) el.setAttribute("href", relPath)
    }
  }

  // Clean up failed/skipped assets: remove their src/href to avoid dangling
  // external requests in offline mode and potential privacy leaks.
  for (const a of assets) {
    if (a.status === "fetched") continue
    const els = [...document.querySelectorAll(`[data-origin-url="${escCssAttr(a.originUrl)}"]`)]
    for (const el of els) {
      const tag = el.tagName.toLowerCase()
      // Remove the resource attribute so the browser doesn't attempt to load it
      if (tag === "link") {
        el.removeAttribute("href")
      } else if (
        tag === "script" ||
        tag === "img" ||
        tag === "source" ||
        tag === "video" ||
        tag === "audio"
      ) {
        el.removeAttribute("src")
      }
      // For srcset, also clear it since all candidates would fail
      if ((tag === "img" || tag === "source") && el.hasAttribute("srcset")) {
        el.removeAttribute("srcset")
      }
    }
  }

  const head = document.querySelector("head")
  if (head) {
    const ms = document.createElement("meta")
    ms.setAttribute("name", "snapshot:source")
    ms.setAttribute("content", options.url)
    head.prepend(ms)

    const mt = document.createElement("meta")
    mt.setAttribute("name", "snapshot:time")
    mt.setAttribute("content", new Date().toISOString())
    const nextNode = ms.nextSibling
    if (nextNode) {
      head.insertBefore(mt, nextNode)
    } else {
      head.appendChild(mt)
    }
  }

  // Clean up the snapshot helper attribute to avoid leaking the full URL in the output
  for (const el of document.querySelectorAll("[data-snapshot-id]")) {
    el.removeAttribute("data-snapshot-id")
  }
  for (const el of document.querySelectorAll("[data-origin-url]")) {
    el.removeAttribute("data-origin-url")
  }

  let html = document.toString()
  if (!html.startsWith("<!")) html = "<!DOCTYPE html>\n" + html

  // Apply pretty-printing if requested
  if (options.pretty) {
    html = prettyPrintHtml(html)
  }

  writeFileSync(join(outDir, "index.html"), html, "utf8")

  const manifest: Record<string, { size: number; mime: string }> = {}
  for (const a of assets) {
    if (a.status === "fetched") {
      manifest[a.originUrl] = { size: a.size, mime: a.mime }
    }
  }

  const meta = {
    sourceUrl: options.url,
    timestamp: new Date().toISOString(),
    stats: {
      total: assets.length,
      fetched: assets.filter((a) => a.status === "fetched").length,
      failed: assets.filter((a) => a.status === "failed").length,
      skipped: assets.filter((a) => a.status === "skipped").length,
      totalBytes: assets.reduce((s, a) => s + a.size, 0),
    },
    assets: assets.map((a) => ({
      originUrl: a.originUrl,
      localPath: assetMap.get(a.originUrl) || null,
      type: a.type,
      status: a.status,
      size: a.size,
      mime: a.mime,
      error: a.error || null,
    })),
    manifest,
  }

  writeFileSync(join(outDir, "snapshot.json"), JSON.stringify(meta, null, 2), "utf8")
}
