/**
 * Artifact preview utility functions
 * Pure functions for iframe-based rendering (HTML, SVG, React)
 */

import DOMPurify from "dompurify"
import { LruCache } from "@cognia/primitives"
import { injectFrameCsp, injectFrameHead, serializeFrameCsp } from "@/lib/security/frame-csp"
import type { ArtifactRendererProfile } from "@/types"

export const DIAGRAM_DESIGN_THEME_KEYS = [
  "--background",
  "--card",
  "--foreground",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
  "--border",
  "--info",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
] as const

export type DiagramDesignThemeVariable = (typeof DIAGRAM_DESIGN_THEME_KEYS)[number]
export type ArtifactThemeVariables = Partial<Record<DiagramDesignThemeVariable, string>>

export const DIAGRAM_DESIGN_THEME_DEFAULTS: Record<DiagramDesignThemeVariable, string> = {
  "--background": "#ffffff",
  "--card": "#ffffff",
  "--foreground": "#171717",
  "--muted-foreground": "#737373",
  "--primary": "#2563eb",
  "--primary-foreground": "#ffffff",
  "--border": "#e5e7eb",
  "--info": "#0284c7",
  "--chart-1": "#e76e50",
  "--chart-2": "#2a9d8f",
  "--chart-3": "#264653",
  "--chart-4": "#e9c46a",
  "--chart-5": "#f4a261",
}

interface SanitizeHTMLOptions {
  wholeDocument?: boolean
  rendererProfile?: ArtifactRendererProfile
}

interface RenderHTMLOptions extends SanitizeHTMLOptions {
  themeVariables?: ArtifactThemeVariables
}

const SAFE_EMBEDDED_URL =
  /^(?:#|url\(\s*#[^)]+\s*\)$|data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp);)/i
const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?(?:["'][^"']+["']|[^;)\s]+)\s*\)?\s*;?/gi
const CSS_URL_PATTERN = /url\(\s*(["']?)(.*?)\1\s*\)/gi

function stripNetworkCss(css: string): string {
  return css
    .replace(CSS_IMPORT_PATTERN, "")
    .replace(CSS_URL_PATTERN, (match, _quote: string, url: string) =>
      SAFE_EMBEDDED_URL.test(url.trim()) ? match : "none"
    )
}

function prepareDiagramHTMLForSanitization(content: string): string {
  return stripNetworkCss(content).replace(/<(?:link|base)\b[^>]*>/gi, "")
}

function enforceDiagramNoNetworkPolicy(content: string, wholeDocument: boolean): string {
  const parsed = new DOMParser().parseFromString(content, "text/html")

  parsed.querySelectorAll("link, base").forEach((element) => element.remove())
  parsed.querySelectorAll("style").forEach((element) => {
    element.textContent = stripNetworkCss(element.textContent || "")
  })

  parsed.querySelectorAll("*").forEach((element) => {
    const style = element.getAttribute("style")
    if (style) element.setAttribute("style", stripNetworkCss(style))

    element.removeAttribute("srcset")
  })

  if (!wholeDocument) return parsed.body.innerHTML

  const csp = parsed.createElement("meta")
  csp.setAttribute("http-equiv", "Content-Security-Policy")
  csp.setAttribute(
    "content",
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"
  )
  parsed.head.prepend(csp)
  return `<!DOCTYPE html>\n${parsed.documentElement.outerHTML}`
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

/**
 * Sanitising is a full DOM parse of the whole document, and it runs on every
 * preview render — including the ones a live-typing Canvas produces. Bounded so
 * a long session cannot accumulate megabytes of sanitised HTML; the same shape
 * `lib/shiki/highlight-cache.ts` and `packages/mermaid/src/render-cache.ts` use.
 */
const SANITIZE_CACHE_SIZE = 40
const sanitizeCache = new LruCache<string>(SANITIZE_CACHE_SIZE)
const svgSanitizeCache = new LruCache<string>(SANITIZE_CACHE_SIZE)

/** Test seam — drops both caches. */
export function clearArtifactSanitizeCaches(): void {
  sanitizeCache.clear()
  svgSanitizeCache.clear()
}

/**
 * Sanitize an HTML document for passive iframe previews.
 *
 * Scripts, event handlers and executable form controls are removed while
 * preserving document formatting, tables, styles, images and safe links.
 */
export function sanitizeHTML(
  content: string,
  { wholeDocument = true, rendererProfile }: SanitizeHTMLOptions = {}
): string {
  const cacheKey = `${wholeDocument ? "1" : "0"}|${rendererProfile ?? ""}|${content}`
  const cached = sanitizeCache.get(cacheKey)
  if (cached !== undefined) return cached
  const isDiagramDesign = rendererProfile === "diagram-design-v1"
  const sanitized = DOMPurify.sanitize(
    isDiagramDesign ? prepareDiagramHTMLForSanitization(content) : content,
    {
      WHOLE_DOCUMENT: wholeDocument,
      ADD_TAGS: isDiagramDesign ? ["style", "meta"] : ["style", "link", "meta"],
      ADD_ATTR: ["target", "rel", "class", "id", "style"],
      ALLOW_DATA_ATTR: true,
      ...(isDiagramDesign ? { ALLOWED_URI_REGEXP: SAFE_EMBEDDED_URL } : {}),
      FORBID_ATTR: ["http-equiv"],
      FORBID_TAGS: [
        "script",
        "form",
        "input",
        "button",
        "textarea",
        "select",
        "option",
        ...(isDiagramDesign ? ["link", "base", "iframe", "object", "embed"] : []),
      ],
    }
  )

  const out = isDiagramDesign ? enforceDiagramNoNetworkPolicy(sanitized, wholeDocument) : sanitized
  sanitizeCache.set(cacheKey, out)
  return out
}

export function applyArtifactThemeVariables(
  doc: Document,
  themeVariables: ArtifactThemeVariables
): void {
  for (const key of DIAGRAM_DESIGN_THEME_KEYS) {
    const value = themeVariables[key]
    if (value) doc.documentElement.style.setProperty(key, value)
  }
}

/**
 * Render sanitized HTML content into an iframe document
 */
export function renderHTML(doc: Document, content: string, options: RenderHTMLOptions = {}): void {
  const sanitized = sanitizeHTML(content, options)
  doc.open()
  doc.write(sanitized)
  doc.close()
  // Injected for EVERY html preview, not only the diagram-design profile. The
  // variables are `:root` custom properties, so an author who set an explicit
  // background still wins — this only gives a document that did NOT choose one
  // something that matches the app in both themes, instead of the browser's
  // white default.
  if (options.themeVariables) applyArtifactThemeVariables(doc, options.themeVariables)
}

/**
 * Render sanitized SVG content into an iframe document
 */
export function renderSVG(
  doc: Document,
  content: string,
  themeVariables?: ArtifactThemeVariables
): void {
  let sanitized = svgSanitizeCache.get(content)
  if (sanitized === undefined) {
    sanitized = DOMPurify.sanitize(content, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ["style"],
    })
    svgSanitizeCache.set(content, sanitized)
  }
  doc.open()
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        /* The host injects --background via applyArtifactThemeVariables; the
           literal is the fallback for a frame that never receives it. A
           hard-coded light backdrop made every SVG preview a bright rectangle
           in a dark app. */
        body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: var(--background, #f5f5f5); }
        svg { max-width: 100%; max-height: 100vh; }
      </style>
    </head>
    <body>${sanitized}</body>
    </html>
  `)
  doc.close()
  if (themeVariables) applyArtifactThemeVariables(doc, themeVariables)
}

/**
 * Where the frame may load code from, and which bundles it needs. Supplied by
 * `lib/artifacts/react-runtime-loader.ts` — this module stays pure so the shell
 * markup can be asserted without a network.
 */
export interface ArtifactFrameRuntime {
  /** Absolute origin serving `/artifact-runtime/` — named in the frame's CSP. */
  origin: string
  /** Absolute URL of the React + ReactDOM bundle. */
  reactRuntimeUrl: string
  /** Absolute URL of the in-frame bootstrap. */
  shellUrl: string
}

/**
 * The policy a scripted artifact frame carries.
 *
 * Measured in a packaged Tauri shell (ADR-0158): a sandboxed `about:srcdoc`
 * child INHERITS `src-tauri/tauri.conf.json`'s policy, and the two policies
 * intersect. So this list is not the frame's whole policy — it is the FLOOR for
 * the shells that have none of their own (browser, `pnpm dev`, Capacitor), and
 * it has to keep naming what the desktop policy already allows or the
 * intersection is empty. `'unsafe-inline'` is deliberately absent: the desktop
 * policy would strike it out anyway, so relying on it is how the previous shell
 * came to run nothing at all.
 */
export function buildArtifactFrameCsp(origin: string): string {
  return serializeFrameCsp([
    ["default-src", "'none'"],
    // `origin` for the two bundles, `blob:` for the artifact's own code. Both
    // survive the intersection with `script-src 'self' 'wasm-unsafe-eval' blob:`.
    ["script-src", `${origin} blob:`],
    ["style-src", "'unsafe-inline'"],
    ["img-src", "data: blob:"],
    ["font-src", "data:"],
    // An artifact preview has no business reaching the network.
    ["connect-src", "'none'"],
    ["form-action", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
  ])
}

const ARTIFACT_FRAME_STYLE =
  "<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif}*{box-sizing:border-box}</style>"

/**
 * Static HTML shell for a React artifact preview.
 *
 * No inline script and no `eval`. The document loads two same-origin bundles
 * and then waits: the host posts `artifact-shell-config` (localized strings)
 * and `render-component` (JSX already transformed by the host's Worker), and
 * the bootstrap runs that as a `blob:` script.
 *
 * What this replaced: four `https://unpkg.com` / `cdn.tailwindcss.com`
 * `<script src>` tags — of which the two React ones had been a hard 404 since
 * React 19 dropped UMD builds — plus a 15-second timeout notice that every
 * preview, in every shell, eventually showed.
 */
export function getReactShellHtml(runtime: ArtifactFrameRuntime): string {
  // Built through the shared injector rather than a second hand-written meta
  // tag, so the escaping rule lives in exactly one place.
  return injectFrameCsp(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="${escapeHtml(runtime.reactRuntimeUrl)}"></script>
  <script src="${escapeHtml(runtime.shellUrl)}"></script>
  ${ARTIFACT_FRAME_STYLE}
</head>
<body>
  <div id="root"></div>
</body>
</html>`,
    buildArtifactFrameCsp(runtime.origin)
  )
}

/**
 * Shell for an interactive HTML artifact: the artifact's own sanitized document
 * plus the same policy and bootstrap. The scripts lifted out of it by
 * `compileInteractiveHtml` arrive over `run-scripts`.
 */
export function getInteractiveHtmlShellHtml(
  sanitizedDocument: string,
  runtime: Pick<ArtifactFrameRuntime, "origin" | "shellUrl">
): string {
  // Script first, policy second — both splice in at the START of `<head>`, so
  // injecting the policy last is what puts it AHEAD of the script it governs.
  return injectFrameCsp(
    injectFrameHead(sanitizedDocument, `<script src="${escapeHtml(runtime.shellUrl)}"></script>`),
    buildArtifactFrameCsp(runtime.origin)
  )
}
