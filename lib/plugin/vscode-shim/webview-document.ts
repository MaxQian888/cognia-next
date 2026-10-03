/**
 * Turn a VS Code webview's HTML into a document the app's sandboxed frame can
 * run.
 *
 * The frame is an `about:srcdoc` child, so it inherits the packaged app's
 * content security policy (ADR-0158): no inline scripts, no `eval`, and no
 * loads from anywhere but the app and `blob:` / `data:`. VS Code webviews
 * instead load their files from `asWebviewUri` URIs and often run inline
 * scripts. So, before the frame sees the HTML:
 *
 *   - every file it names through a webview resource URI (resolved against its
 *     `<base>`) is read through the extension host and inlined: images, media
 *     and fonts as `data:` URLs, stylesheets as `<style>` blocks (their own
 *     `url()`s and `@import`s inlined the same way);
 *   - its scripts, inline or from a file, are taken out in document order, to
 *     be run by the shell (`public/vscode-webview/webview-shell.js`) as
 *     in-frame `blob:` scripts carrying their original `nonce`;
 *   - the shell, the frame's own policy and the theme go first in `<head>`.
 *
 * Anything remote (a CDN script or stylesheet) cannot load in the frame and
 * is dropped with a warning; files outside the webview's resource roots are
 * refused by the host and reported the same way.
 */

import { injectFrameHead, serializeFrameCsp } from "@/lib/security/frame-csp"

import { VSCODE_WEBVIEW_DEFAULT_CSS, type VscodeThemeKind } from "./webview-theme"

/** The authority `asWebviewUri` gives resource URIs (`vscode-shim/webviews.ts`). */
export const WEBVIEW_RESOURCE_AUTHORITY = "file+.vscode-resource.cognia.invalid"
export const WEBVIEW_RESOURCE_ORIGIN = `https://${WEBVIEW_RESOURCE_AUTHORITY}`

/** How deep stylesheets may `@import` one another. */
const MAX_IMPORT_DEPTH = 4

const JAVASCRIPT_TYPES = new Set([
  "",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "module",
])

export interface WebviewResource {
  bytes: Uint8Array
  mime: string
}

export interface WebviewScript {
  code: string
  nonce?: string
  module: boolean
  /** The resource URI the script came from, for `document.currentScript.src` and stack traces. */
  url?: string
}

export interface PreparedWebviewDocument {
  srcDoc: string
  /** Scripts for the shell to run, in document order. Empty when scripts are off. */
  scripts: WebviewScript[]
  /** The webview's `<base href>`, against which the shell resolves URIs set later. */
  baseUrl?: string
  /** What could not be loaded, for the extension's log. */
  warnings: string[]
}

export interface PrepareWebviewInput {
  html: string
  enableScripts: boolean
  /** Absolute URL of `webview-shell.js`, on the app's own origin. */
  shellUrl: string
  /**
   * The app's origin, as the frame's policy names it. Given rather than parsed
   * from `shellUrl`: the desktop app's `tauri://localhost` is a custom scheme,
   * whose WHATWG `URL.origin` is `"null"`.
   */
  shellOrigin: string
  /** Read a webview resource through the extension host. */
  readResource: (url: string) => Promise<WebviewResource>
  themeCss: string
  themeKind: VscodeThemeKind
}

export function isWebviewResource(url: string | undefined | null): url is string {
  return typeof url === "string" && url.startsWith(`${WEBVIEW_RESOURCE_ORIGIN}/`)
}

/** `url` resolved against `base`; `undefined` when it is not a URL at all. */
function resolveUrl(url: string, base: string | undefined): string | undefined {
  try {
    return base ? new URL(url, base).href : new URL(url).href
  } catch {
    return undefined
  }
}

/** Bytes as base64, in chunks so a large file does not overflow the argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function dataUrl(resource: WebviewResource): string {
  return `data:${resource.mime};base64,${bytesToBase64(resource.bytes)}`
}

const decoder = new TextDecoder()

/** The frame's own policy, on top of the one it inherits from the app. */
export function webviewFrameCsp(shellOrigin: string): string {
  return serializeFrameCsp([
    ["default-src", "'none'"],
    ["script-src", `${shellOrigin} blob:`],
    ["style-src", "'unsafe-inline'"],
    ["img-src", "data: blob:"],
    ["media-src", "data: blob:"],
    ["font-src", "data: blob:"],
    ["connect-src", "'none'"],
    ["frame-src", "'none'"],
    ["form-action", "'none'"],
  ])
}

class Inliner {
  readonly warnings: string[] = []
  private readonly cache = new Map<string, Promise<WebviewResource | undefined>>()

  constructor(private readonly read: (url: string) => Promise<WebviewResource>) {}

  /** The resource at `url`, or `undefined` (with a warning) when it cannot be read. */
  load(url: string): Promise<WebviewResource | undefined> {
    let pending = this.cache.get(url)
    if (!pending) {
      pending = this.read(url).catch((error: unknown) => {
        this.warnings.push(
          `Could not load ${url}: ${error instanceof Error ? error.message : String(error)}`
        )
        return undefined
      })
      this.cache.set(url, pending)
    }
    return pending
  }

  async dataUrlFor(url: string): Promise<string | undefined> {
    const resource = await this.load(url)
    return resource ? dataUrl(resource) : undefined
  }

  /** Inline the resources a stylesheet at `base` names: `url()`s as data, `@import`s as text. */
  async css(text: string, base: string | undefined, depth = 0): Promise<string> {
    const imports: Array<{ match: string; url: string }> = []
    const importPattern = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi
    for (const match of text.matchAll(importPattern)) {
      const url = resolveUrl(match[2], base)
      if (isWebviewResource(url)) imports.push({ match: match[0], url })
    }
    let result = text
    for (const { match, url } of imports) {
      if (depth >= MAX_IMPORT_DEPTH) {
        this.warnings.push(
          `Stylesheet imports nest deeper than ${MAX_IMPORT_DEPTH}; ${url} skipped`
        )
        result = result.replace(match, "")
        continue
      }
      const resource = await this.load(url)
      result = result.replace(
        match,
        resource ? await this.css(decoder.decode(resource.bytes), url, depth + 1) : ""
      )
    }
    const urlPattern = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi
    const replacements = new Map<string, string>()
    for (const match of result.matchAll(urlPattern)) {
      const url = resolveUrl(match[2].trim(), base)
      if (!isWebviewResource(url) || replacements.has(match[0])) continue
      const inlined = await this.dataUrlFor(url.split("#")[0])
      if (inlined) {
        const fragment = url.includes("#") ? url.slice(url.indexOf("#")) : ""
        replacements.set(match[0], `url("${inlined}${fragment}")`)
      }
    }
    for (const [from, to] of replacements) result = result.split(from).join(to)
    return result
  }
}

/** Rewrite each candidate of a `srcset` that names a resource. */
async function inlineSrcset(
  value: string,
  base: string | undefined,
  inliner: Inliner
): Promise<string> {
  const candidates = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const rewritten: string[] = []
  for (const candidate of candidates) {
    const [url, ...descriptor] = candidate.split(/\s+/)
    const resolved = resolveUrl(url, base)
    const inlined = isWebviewResource(resolved) ? await inliner.dataUrlFor(resolved) : undefined
    rewritten.push([inlined ?? url, ...descriptor].join(" "))
  }
  return rewritten.join(", ")
}

const MEDIA_ATTRIBUTES: ReadonlyArray<readonly [string, string]> = [
  ["img", "src"],
  ["source", "src"],
  ["video", "src"],
  ["video", "poster"],
  ["audio", "src"],
  ["track", "src"],
  ["embed", "src"],
  ["object", "data"],
  ['input[type="image" i]', "src"],
  ["image", "href"],
  ["image", "xlink:href"],
  ["use", "href"],
  ["use", "xlink:href"],
]

export async function prepareWebviewDocument(
  input: PrepareWebviewInput
): Promise<PreparedWebviewDocument> {
  const doc = new DOMParser().parseFromString(input.html, "text/html")
  const inliner = new Inliner(input.readResource)
  const baseElement = doc.querySelector("base[href]")
  const baseHref = baseElement?.getAttribute("href") ?? undefined
  const base = baseHref ? resolveUrl(baseHref, undefined) : undefined
  // The app's policy refuses any `<base>` that is not its own origin; the
  // frame resolves against it through the shell instead.
  for (const element of doc.querySelectorAll("base")) element.remove()

  const scripts: WebviewScript[] = []
  for (const element of [...doc.querySelectorAll("script")]) {
    const type = (element.getAttribute("type") ?? "").trim().toLowerCase()
    // Data blocks (`application/json`, templates) stay for the page's scripts to read.
    if (!JAVASCRIPT_TYPES.has(type)) continue
    element.remove()
    if (!input.enableScripts) continue
    const nonce = element.getAttribute("nonce") ?? undefined
    const src = element.getAttribute("src")
    const script = { nonce, module: type === "module" }
    if (src === null) {
      scripts.push({ ...script, code: element.textContent ?? "" })
      continue
    }
    const url = resolveUrl(src, base)
    if (!isWebviewResource(url)) {
      inliner.warnings.push(`Script ${src} is not a webview resource and cannot load`)
      continue
    }
    const resource = await inliner.load(url)
    if (resource) scripts.push({ ...script, code: decoder.decode(resource.bytes), url })
  }

  for (const element of [...doc.querySelectorAll("link[href]")]) {
    const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/)
    const url = resolveUrl(element.getAttribute("href") ?? "", base)
    if (rel.includes("stylesheet")) {
      element.remove()
      if (!isWebviewResource(url)) {
        inliner.warnings.push(
          `Stylesheet ${element.getAttribute("href")} is not a webview resource and cannot load`
        )
        continue
      }
      const resource = await inliner.load(url)
      if (!resource) continue
      const style = doc.createElement("style")
      const media = element.getAttribute("media")
      if (media) style.setAttribute("media", media)
      style.textContent = await inliner.css(decoder.decode(resource.bytes), url)
      ;(doc.head ?? doc.documentElement).appendChild(style)
      continue
    }
    // Preloads, icons and manifests have nothing to load in the frame.
    if (isWebviewResource(url)) element.remove()
  }

  for (const style of doc.querySelectorAll("style")) {
    style.textContent = await inliner.css(style.textContent ?? "", base)
  }
  for (const element of doc.querySelectorAll("[style]")) {
    const value = element.getAttribute("style") ?? ""
    if (/url\(/i.test(value)) element.setAttribute("style", await inliner.css(value, base))
  }

  for (const [selector, attribute] of MEDIA_ATTRIBUTES) {
    for (const element of doc.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute)
      if (value === null) continue
      const url = resolveUrl(value, base)
      if (!isWebviewResource(url)) continue
      const inlined = await inliner.dataUrlFor(url)
      if (inlined) element.setAttribute(attribute, inlined)
    }
  }
  for (const element of doc.querySelectorAll("img[srcset], source[srcset]")) {
    element.setAttribute(
      "srcset",
      await inlineSrcset(element.getAttribute("srcset") ?? "", base, inliner)
    )
  }

  const body = doc.body ?? doc.documentElement
  body.classList.remove("vscode-light", "vscode-dark")
  body.classList.add(input.themeKind)
  body.setAttribute("data-vscode-theme-kind", input.themeKind)

  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${webviewFrameCsp(input.shellOrigin).replaceAll('"', "&quot;")}">`,
    `<style id="_vscodeDefaultStyles">${VSCODE_WEBVIEW_DEFAULT_CSS}</style>`,
    `<style id="_vscodeThemeVariables">${input.themeCss}</style>`,
    ...(input.enableScripts ? [`<script src="${input.shellUrl}"></script>`] : []),
  ].join("")
  const html = `<!doctype html>${doc.documentElement.outerHTML}`

  return {
    srcDoc: injectFrameHead(html, head),
    scripts,
    ...(base ? { baseUrl: base } : {}),
    warnings: inliner.warnings,
  }
}
