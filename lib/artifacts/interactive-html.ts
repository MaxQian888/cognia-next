/**
 * Compile an HTML artifact into something that can actually run under the
 * packaged desktop shell's CSP.
 *
 * The static preview (`sanitizeHTML`) strips script/form/input/button outright.
 * Turning that off is not enough: measured in a packaged Tauri shell
 * (ADR-0158), an `about:srcdoc` child — sandboxed, opaque origin, whatever meta
 * CSP you give it — INHERITS `src-tauri/tauri.conf.json`'s policy, which grants
 * neither `'unsafe-inline'` nor `'unsafe-eval'`. An artifact's own
 * `<script>…</script>` and `onclick="…"` therefore cannot run as written.
 *
 * Two things do run there: a same-origin URL, and a `blob:` script. So this
 * module lifts every executable byte out of the markup and hands it back as
 * ordered source strings the frame turns into `blob:` scripts:
 *
 * - inline `<script>` bodies, in document order;
 * - `on*` attributes, rewritten into `addEventListener` calls whose bodies are
 *   the original handler source (still source text — no `new Function`, which
 *   would need `'unsafe-eval'`);
 * - `<script src="https://…">` is DROPPED and reported, because the frame's
 *   policy names no third-party origin and never will.
 *
 * The result is strictly safer than an `'unsafe-inline'` frame would have been:
 * the artifact runs with an opaque origin, no host access, no cookies, no
 * storage, no network, and no way to introduce new code at runtime.
 */

import DOMPurify from "dompurify"

/** Marks an element that carried inline handlers, so the bootstrap can find it. */
export const INTERACTIVE_HANDLER_ATTRIBUTE = "data-cognia-handler"

export interface InteractiveHandler {
  /** Value of {@link INTERACTIVE_HANDLER_ATTRIBUTE} on the owning element. */
  id: string
  /** DOM event name, with the `on` prefix removed. */
  event: string
  /** The original handler source, verbatim. */
  body: string
}

export interface InteractiveHtmlProgram {
  /** Sanitized document, with every script and `on*` attribute removed. */
  html: string
  /** Inline script bodies in document order, followed by the handler wiring. */
  scripts: Array<{ code: string; module?: boolean }>
  /** `src` values of external scripts that were dropped, for the UI to report. */
  droppedExternalScripts: string[]
}

/** `on*` attributes are the only executable attributes HTML has. */
function handlerAttributes(element: Element): Array<{ event: string; body: string }> {
  const found: Array<{ event: string; body: string }> = []
  for (const attribute of Array.from(element.attributes)) {
    if (!/^on[a-z]+$/i.test(attribute.name)) continue
    found.push({ event: attribute.name.slice(2).toLowerCase(), body: attribute.value })
  }
  return found
}

/**
 * Build the source that re-attaches the handlers. Bodies are embedded as
 * function bodies — the same code the browser would have compiled for the
 * attribute — so globals declared by the artifact's own scripts stay in scope
 * and `this` is still the element.
 */
export function buildHandlerWiringSource(handlers: InteractiveHandler[]): string {
  if (handlers.length === 0) return ""
  const lines = handlers.map((handler) => {
    const selector = JSON.stringify(`[${INTERACTIVE_HANDLER_ATTRIBUTE}="${handler.id}"]`)
    return [
      `(function () {`,
      `  var target = document.querySelector(${selector});`,
      `  if (!target) return;`,
      `  target.addEventListener(${JSON.stringify(handler.event)}, function (event) {`,
      handler.body,
      `  });`,
      `})();`,
    ].join("\n")
  })
  return lines.join("\n")
}

/**
 * Extract the executable parts of an HTML artifact and sanitize what is left.
 *
 * Order matters: handlers and scripts are collected from the PARSED document
 * before DOMPurify runs, because DOMPurify's whole job is to delete exactly the
 * things being collected. The marker attribute survives sanitization
 * (`ALLOW_DATA_ATTR`), which is what lets the wiring find its element again.
 */
export function compileInteractiveHtml(content: string): InteractiveHtmlProgram {
  const parsed = new DOMParser().parseFromString(content, "text/html")
  const scripts: Array<{ code: string; module?: boolean }> = []
  const handlers: InteractiveHandler[] = []
  const droppedExternalScripts: string[] = []
  let nextHandlerId = 0

  for (const element of Array.from(parsed.querySelectorAll("*"))) {
    const found = handlerAttributes(element)
    if (found.length > 0) {
      const id = String(nextHandlerId++)
      element.setAttribute(INTERACTIVE_HANDLER_ATTRIBUTE, id)
      for (const { event, body } of found) {
        element.removeAttribute(`on${event}`)
        handlers.push({ id, event, body })
      }
    }
  }

  for (const script of Array.from(parsed.querySelectorAll("script"))) {
    const src = script.getAttribute("src")
    if (src) {
      // The frame's policy names the shell origin and `blob:` only. A third
      // party script cannot load, so say so rather than fail silently.
      droppedExternalScripts.push(src)
    } else {
      const type = (script.getAttribute("type") || "").toLowerCase()
      const isModule = type === "module"
      // Anything that is not JavaScript (a JSON payload, a template) is left in
      // the markup by NOT collecting it here; the sanitizer drops it.
      const isJavaScript =
        isModule || type === "" || type === "text/javascript" || type === "application/javascript"
      if (isJavaScript && script.textContent) {
        scripts.push(
          isModule ? { code: script.textContent, module: true } : { code: script.textContent }
        )
      }
    }
    script.remove()
  }

  const wiring = buildHandlerWiringSource(handlers)
  if (wiring) scripts.push({ code: wiring })

  const sanitized = DOMPurify.sanitize(parsed.documentElement.outerHTML, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style", "meta"],
    ADD_ATTR: ["target", "rel", "class", "id", "style", "value", "type", "name", "placeholder"],
    ALLOW_DATA_ATTR: true,
    // `http-equiv` would let an artifact install its OWN CSP meta and widen the
    // policy the preview injected.
    FORBID_ATTR: ["http-equiv"],
    // Form controls stay — they are the point of an interactive preview. What
    // is still refused is anything that can reach the network or nest a browsing
    // context, none of which the frame's policy would allow anyway.
    FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "link"],
  })

  return { html: `<!DOCTYPE html>\n${sanitized}`, scripts, droppedExternalScripts }
}

/** True when an HTML artifact has anything the interactive mode would run. */
export function hasInteractiveContent(content: string): boolean {
  return (
    /<script[\s>]/i.test(content) || /\son[a-z]+\s*=/i.test(content) || /<form[\s>]/i.test(content)
  )
}
