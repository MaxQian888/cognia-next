/**
 * Scrub the SVG string Mermaid produces, before any caller injects it with
 * `dangerouslySetInnerHTML`.
 *
 * Why this is needed: Mermaid runs at `securityLevel: "loose"` so HTML labels
 * (`<br/>`, styled spans) keep rendering, and diagram source is untrusted — it
 * comes from the model, from an imported session, or from a public share link.
 * "Loose" means a label body reaches the output markup close to verbatim, and
 * that output is then injected as raw HTML.
 *
 * Why not DOMPurify (which this repo already depends on): its SVG profile
 * keeps `<foreignObject>` but drops the HTML elements *inside* it, because in
 * the SVG namespace `div`/`span` are not valid SVG. `foreignObject` is exactly
 * how Mermaid carries HTML labels, so a DOMPurify pass renders every diagram
 * with blank nodes — see the test that pins this. The scrub below is narrower
 * on purpose: it removes the executable surface and touches nothing else.
 *
 * Parsing happens inside an inert `<template>`, which is both safe (no script
 * runs, no resource loads) and faithful — it is the same HTML parsing path the
 * markup takes when a caller finally assigns it to `innerHTML`.
 */

/** Elements that can execute or fetch. Mermaid emits none of them. */
const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "audio",
  "video",
  "form",
  "input",
  "button",
])

/** URL schemes a diagram may legitimately point at. */
const SAFE_URL = /^(?:#|https?:|mailto:|data:image\/(?:png|jpeg|gif|webp|svg\+xml);)/i

const URL_ATTRIBUTES = ["href", "xlink:href", "src", "action", "formaction"]

/**
 * Largest SVG we will inject, in characters. A diagram whose layout explodes
 * (a few hundred nodes with long labels is enough) produces megabytes of
 * markup, and parsing that on the main thread is a multi-second block. The
 * caller surfaces this as a render error, which is a far better outcome than a
 * frozen tab.
 */
export const MAX_SVG_CHARS = 2_000_000

export class MermaidSvgTooLargeError extends Error {
  readonly chars: number
  constructor(chars: number) {
    super(`mermaid produced ${chars} characters of SVG (limit ${MAX_SVG_CHARS})`)
    this.name = "MermaidSvgTooLargeError"
    this.chars = chars
  }
}

/**
 * Remove scripts, event handlers and unsafe URL targets from `svg`.
 *
 * Throws `MermaidSvgTooLargeError` when the diagram exceeds `MAX_SVG_CHARS`.
 * Returns the input unchanged when there is no DOM (SSR / node test env) —
 * nothing can be injected there either.
 */
export function sanitizeMermaidSvg(svg: string): string {
  if (svg.length > MAX_SVG_CHARS) throw new MermaidSvgTooLargeError(svg.length)
  if (typeof document === "undefined" || typeof document.createElement !== "function") return svg

  const template = document.createElement("template")
  template.innerHTML = svg
  scrub(template.content)
  return template.innerHTML
}

function scrub(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (FORBIDDEN_TAGS.has(element.tagName.toLowerCase())) {
      element.remove()
      continue
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      // `on*` covers every inline handler, including ones we have not heard of.
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name)
        continue
      }
      if (URL_ATTRIBUTES.includes(name) && !SAFE_URL.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name)
      }
    }
  }
}
