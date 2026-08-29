/**
 * Artifact preview utility functions
 * Pure functions for iframe-based rendering (HTML, SVG, React)
 */

import DOMPurify from "dompurify"
import { LruCache } from "@cognia/primitives"
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
const sanitizeCache = new LruCache<string, string>(SANITIZE_CACHE_SIZE)
const svgSanitizeCache = new LruCache<string, string>(SANITIZE_CACHE_SIZE)

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
 * Localized strings injected into the React preview iframe shell.
 */
export interface ReactShellMessages {
  cdnLoadTitle: string
  cdnLoadDescription: string
  noComponentFound: string
}

/**
 * Generate a static HTML shell for React preview.
 * Content is received via postMessage to prevent XSS via template string injection.
 * Uses React 19 CDN and CSP meta tag to restrict external requests.
 *
 * `messages` is JSON-serialized into the inline script — values may contain any
 * characters; JSON.stringify handles all required escaping (quotes, backslashes,
 * unicode, and the </script> sequence is broken with a closing-tag escape).
 */
export function getReactShellHtml(messages: ReactShellMessages): string {
  const messagesJson = JSON.stringify(messages).replace(/<\//g, "<\\/")
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src data: blob:; font-src data:;">
  <script src="https://unpkg.com/react@19/umd/react.development.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@19/umd/react-dom.development.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, sans-serif; }
    * { box-sizing: border-box; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    var __ARTIFACT_MSG = ${messagesJson};
    function _escapeMsg(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // CDN load check with timeout
    var _cdnTimeout = setTimeout(function() {
      if (typeof React === 'undefined' || typeof ReactDOM === 'undefined' || typeof Babel === 'undefined') {
        document.getElementById('root').innerHTML =
          '<div style="color: #b45309; padding: 16px; background: #fef3c7; border-radius: 8px;">' +
          '<strong>' + _escapeMsg(__ARTIFACT_MSG.cdnLoadTitle) + '</strong>' +
          '<p style="margin:8px 0 0">' + _escapeMsg(__ARTIFACT_MSG.cdnLoadDescription) + '</p></div>';
      }
    }, 15000);

    // Receive component code via postMessage (secure: no template injection)
    window.addEventListener('message', function(event) {
      if (!event.data || event.data.type !== 'render-component') return;
      clearTimeout(_cdnTimeout);
      var code = event.data.code;
      try {
        // Create a script element with Babel transpilation
        var scriptEl = document.createElement('script');
        scriptEl.setAttribute('type', 'text/babel');
        scriptEl.setAttribute('data-presets', 'react');
        scriptEl.textContent = code + '\\n' +
          ';(function() {' +
          '  var components = [' +
          '    typeof App !== "undefined" ? App : null,' +
          '    typeof Component !== "undefined" ? Component : null,' +
          '    typeof Main !== "undefined" ? Main : null,' +
          '  ].filter(Boolean);' +
          '  if (components.length > 0) {' +
          '    var root = ReactDOM.createRoot(document.getElementById("root"));' +
          '    root.render(React.createElement(components[0]));' +
          '  } else {' +
          '    document.getElementById("root").innerHTML = "<p style=\\"color: #666;\\">" + _escapeMsg(__ARTIFACT_MSG.noComponentFound) + "</p>";' +
          '  }' +
          '})();';
        document.body.appendChild(scriptEl);
        // Trigger Babel to process the new script
        if (typeof Babel !== 'undefined' && Babel.transformScriptTags) {
          Babel.transformScriptTags();
        }
      } catch (error) {
        document.getElementById('root').innerHTML = '<div style="color: red; padding: 16px; background: #fee; border-radius: 8px;"><strong>Error:</strong> ' + _escapeMsg(error.message) + '</div>';
        window.parent.postMessage({ type: 'artifact-preview-error', message: error.message }, '*');
      }
    });
  </script>
</body>
</html>`
}
