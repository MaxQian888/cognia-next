/**
 * Read a page the way a person sees it.
 *
 * ## Why this is not the repo's HTML parser
 *
 * `@cognia/document`'s `parseHTML` is cheerio over serialized markup, and
 * cheerio cannot answer the question this feature is built around: *is this
 * visible?* It has no layout, no `getComputedStyle`, no `offsetParent`. A
 * parser-based extractor would happily include a `display: none` cookie
 * banner, an off-screen navigation drawer, an ARIA-hidden dialog, and the
 * contents of a password field. Those are exactly the things the capture
 * contract promises not to send, so the extractor has to run where the layout
 * exists.
 *
 * ## Why it is one self-contained function
 *
 * `chrome.scripting.executeScript({ func })` serializes the function and runs
 * it in the page's isolated world. It cannot close over anything in this
 * module, so every helper it needs is nested inside it. That is a real
 * constraint, not a style choice, and it is why this file reads as one long
 * function rather than a small module.
 */
import type { ExtractionResult } from "../browser-api"

/**
 * Runs **in the page**, not in the extension.
 *
 * Exported so it can be unit-tested against a jsdom document; injected by
 * value at runtime.
 */
export function extractFromDocument(wholePage: boolean): ExtractionResult {
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "IFRAME",
    "FRAME",
    "OBJECT",
    "EMBED",
    "CANVAS",
    "SVG",
    "AUDIO",
    "VIDEO",
    // Form controls hold what the *user* typed, which is not page content and
    // is the most likely place for a credential, a card number or a draft.
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "OPTION",
    "BUTTON",
  ])

  /** Whether an element's subtree may contribute text. */
  function isVisible(element: Element): boolean {
    if (SKIP_TAGS.has(element.tagName)) return false
    if (element.getAttribute("aria-hidden") === "true") return false
    if (element.hasAttribute("hidden")) return false
    // Anything the user is editing is their input, not the page's content —
    // and a draft reply is exactly the kind of thing "send me this page"
    // should not quietly include.
    if (element.getAttribute("contenteditable") === "true") return false
    const html = element as HTMLElement
    if (typeof html.isContentEditable === "boolean" && html.isContentEditable) return false
    const view = element.ownerDocument?.defaultView
    if (view && typeof view.getComputedStyle === "function") {
      const style = view.getComputedStyle(element)
      if (style.display === "none" || style.visibility === "hidden") return false
      // A fully transparent element is visible to the DOM and invisible to the
      // person, and that gap is a classic place to hide injected instructions.
      if (style.opacity === "0") return false
    }
    return true
  }

  /** Collapse runs of whitespace without joining words across block edges. */
  function normalize(value: string): string {
    return value
      .replace(/[ \t\f\v ]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  const doc = document
  const title = doc.title ?? ""
  const url = doc.location?.href ?? ""

  const rawSelection = doc.defaultView?.getSelection?.()?.toString() ?? ""
  const selection = normalize(rawSelection)

  let readableText: string | null = null
  let readableCharacterCount = 0
  if (wholePage && doc.body) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        if (!node.textContent || node.textContent.trim() === "") {
          return NodeFilter.FILTER_REJECT
        }
        // Walk up: a visible text node inside a hidden ancestor is not
        // visible, and checking only the parent misses a hidden container two
        // levels up — which is how most collapsed menus are built.
        let ancestor: Element | null = node.parentElement
        while (ancestor) {
          if (!isVisible(ancestor)) return NodeFilter.FILTER_REJECT
          ancestor = ancestor.parentElement
        }
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const parts: string[] = []
    let current = walker.nextNode()
    while (current) {
      const text = current.textContent ?? ""
      if (text.trim()) parts.push(text)
      current = walker.nextNode()
    }
    const joined = normalize(parts.join("\n"))
    readableCharacterCount = joined.length
    readableText = joined.length > 0 ? joined : null
  }

  return {
    title,
    url,
    selection: selection.length > 0 ? selection : null,
    readableText,
    readableCharacterCount,
  }
}
