import { type Asset, type SnapshotOptions } from "../types.js"

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Escape a string for use as a CSS attribute selector value (inside `[attr="..."]) */
function escCssAttr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function rewriteUrls(text: string, urlMap: Map<string, string>): string {
  let result = text
  // Sort by URL length descending to avoid substring pollution
  // (e.g. "icon.png" must not be replaced before "icon.png?v=2")
  const sorted = [...urlMap.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [original, replacement] of sorted) {
    result = result.split(original).join(replacement)
  }
  return result
}

export function assembleSingleFile(
  document: Document,
  assets: Asset[],
  options: SnapshotOptions
): string {
  const urlMap = new Map<string, string>()
  for (const a of assets) {
    if (a.status === "fetched" && a.dataUri) {
      urlMap.set(a.originUrl, a.dataUri)
    }
  }

  const cssContentMap = new Map<string, string>()
  const jsContentMap = new Map<string, string>()
  for (const a of assets) {
    if (a.status === "fetched" && a.textContent) {
      if (a.type === "css") cssContentMap.set(a.originUrl, a.textContent)
      else if (a.type === "js") jsContentMap.set(a.originUrl, a.textContent)
    }
  }

  // Use data-origin-url (absolute URL) to match CSS/JS content, avoiding href/src relative path mismatches
  const linkSelectors = [...document.querySelectorAll('link[rel="stylesheet"][data-origin-url]')]
  for (const link of linkSelectors) {
    const originUrl = link.getAttribute("data-origin-url")
    if (!originUrl) continue
    const cssText = cssContentMap.get(originUrl) || ""
    if (!cssText) continue

    const style = document.createElement("style")
    const rewritten = rewriteUrls(cssText, urlMap)
    style.textContent = `/* Source: ${esc(originUrl)} */\n${rewritten}`
    link.replaceWith(style)
  }

  const scriptSelectors = [...document.querySelectorAll("script[data-origin-url]")]
  for (const script of scriptSelectors) {
    const originUrl = script.getAttribute("data-origin-url")
    if (!originUrl) continue
    const jsText = jsContentMap.get(originUrl) || ""
    if (!jsText) continue

    script.removeAttribute("src")
    script.textContent = jsText
  }

  for (const a of assets) {
    if (a.status !== "fetched" || !a.dataUri) continue
    const uri = a.dataUri

    const imgs = [...document.querySelectorAll(`img[src="${escCssAttr(a.originUrl)}"]`)]
    for (const img of imgs) img.setAttribute("src", uri)

    const srcsetImgs = [...document.querySelectorAll("img[srcset]")]
    for (const img of srcsetImgs) {
      const val = img.getAttribute("srcset")
      if (val && val.includes(a.originUrl)) {
        // Use regex with lookahead to avoid substring pollution (e.g. "icon.png" vs "icon.png?v=2")
        const escaped = a.originUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        img.setAttribute("srcset", val.replace(new RegExp(escaped + "(?=[\\s,]|$)", "g"), uri))
      }
    }

    const sourceSrcset = [...document.querySelectorAll("source[srcset]")]
    for (const src of sourceSrcset) {
      const val = src.getAttribute("srcset")
      if (val && val.includes(a.originUrl)) {
        const escaped = a.originUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        src.setAttribute("srcset", val.replace(new RegExp(escaped + "(?=[\\s,]|$)", "g"), uri))
      }
    }
  }

  const styleEls = [...document.querySelectorAll("style:not([data-origin-url])")]
  for (const el of styleEls) {
    const text = el.textContent || ""
    if (text) {
      el.textContent = rewriteUrls(text, urlMap)
    }
  }

  const head = document.querySelector("head")
  if (head) {
    const metaSource = document.createElement("meta")
    metaSource.setAttribute("name", "snapshot:source")
    metaSource.setAttribute("content", options.url)
    head.prepend(metaSource)

    const metaTime = document.createElement("meta")
    metaTime.setAttribute("name", "snapshot:time")
    metaTime.setAttribute("content", new Date().toISOString())
    head.insertBefore(metaTime, metaSource.nextSibling ?? null)
  }

  // Clean up the snapshot helper attribute to avoid leaking the full URL in the output
  for (const el of document.querySelectorAll("[data-snapshot-id]")) {
    el.removeAttribute("data-snapshot-id")
  }
  for (const el of document.querySelectorAll("[data-origin-url]")) {
    el.removeAttribute("data-origin-url")
  }

  let html = document.toString()
  if (!html.startsWith("<!")) {
    html = "<!DOCTYPE html>\n" + html
  }

  if (options.pretty) {
    // Only apply pretty-printing to structural HTML, skip script/style textContent
    html = html.replace(
      /(<script[^>]*>[\s\S]*?<\/script>)|(<style[^>]*>[\s\S]*?<\/style>)|(>)\s+(<)/gi,
      (_match, script, style, gt, lt) => {
        if (script) return script
        if (style) return style
        return gt + "\n" + lt
      }
    )
  }

  return html
}
