/**
 * @jest-environment jsdom
 *
 * The anti-drift guard for the one thing `element-pick.ts` re-implements.
 *
 * `lib/browser/overlay.injected.js` cannot be imported — it is an ES5 IIFE that
 * Rust injects into a native webview, and installing it patches `setTimeout`,
 * `setInterval` and `requestAnimationFrame` on whatever global it lands in. So
 * this file is deliberately SEPARATE from `element-pick.test.ts`: Jest gives
 * each test file its own environment, which is the only thing keeping that
 * global patching out of the unit suite.
 *
 * What is asserted here is narrow and load-bearing: an element's identity must
 * read the same whether the user pointed at it in the embedded browser or in an
 * artifact preview. Two surfaces that disagree about what `selector` means
 * would hand the model two different names for the same node.
 */

import fs from "node:fs"
import path from "node:path"

import { cssSelector, domPath } from "./element-pick"

const OVERLAY = fs.readFileSync(
  path.join(__dirname, "..", "..", "browser", "overlay.injected.js"),
  "utf8"
)

interface OverlayApi {
  cssSelector: (el: Element) => string
  domPath: (el: Element) => string
}

function installOverlay(): OverlayApi {
  // Initialization scripts re-run per document load; reset the idempotency flag.
  delete (window as unknown as Record<string, unknown>).__cogniaOverlayInstalled
  // Indirect eval runs in global scope so `window` / `document` bind to jsdom.
  ;(0, eval)(OVERLAY)
  return (window as unknown as { __cogniaOverlay: OverlayApi }).__cogniaOverlay
}

/**
 * Shapes chosen for the decisions the two implementations could plausibly make
 * differently: where the walk stops, whether an index is emitted at 1, whether
 * the index counts same-tag siblings only, and which identity wins on a node
 * carrying both an id and a class.
 */
const CASES: Array<{ name: string; html: string; target: string }> = [
  {
    name: "id anchor partway up",
    html: `<div id="card"><section><button>Go</button></section></div>`,
    target: "button",
  },
  {
    name: "same-tag siblings",
    html: `<ul><li>a</li><li>b</li><li>c</li></ul>`,
    target: "li:nth-child(3)",
  },
  {
    name: "mixed siblings — index counts same-tag only",
    html: `<div><span>x</span><span>y</span><b>z</b><span>w</span></div>`,
    target: "b",
  },
  {
    name: "no ids anywhere",
    html: `<main><article><p>one</p><p>two</p></article></main>`,
    target: "p:nth-child(2)",
  },
  {
    name: "id and class on the same node",
    html: `<div id="root" class="card"><i>x</i></div>`,
    target: "i",
  },
  {
    name: "class-only ancestors",
    html: `<div class="wrap outer"><div class="card wide"><button>Go</button></div></div>`,
    target: "button",
  },
  {
    name: "deeper than the domPath cap",
    html: `<div><div><div><div><div><div><div><i>deep</i></div></div></div></div></div></div></div>`,
    target: "i",
  },
  {
    name: "body-level target",
    html: `<section>top</section>`,
    target: "section",
  },
  {
    name: "id needing escapes",
    html: `<div id="a.b:c"><i>x</i></div>`,
    target: "i",
  },
]

describe("element-pick agrees with the injected browser overlay", () => {
  it.each(CASES)("cssSelector — $name", ({ html, target }) => {
    document.body.innerHTML = html
    const api = installOverlay()
    const el = document.querySelector(target)!
    expect(el).not.toBeNull()
    expect(cssSelector(el)).toBe(api.cssSelector(el))
  })

  it.each(CASES)("domPath — $name", ({ html, target }) => {
    document.body.innerHTML = html
    const api = installOverlay()
    const el = document.querySelector(target)!
    expect(domPath(el)).toBe(api.domPath(el))
  })

  it("agrees that a non-element has no identity", () => {
    document.body.innerHTML = `<p>x</p>`
    const api = installOverlay()
    const textNode = document.querySelector("p")!.firstChild as unknown as Element
    expect(cssSelector(textNode)).toBe(api.cssSelector(textNode))
    expect(domPath(textNode)).toBe(api.domPath(textNode))
  })

  it("produces a selector that actually re-finds the element it described", () => {
    // Agreement would be worthless if both were wrong the same way.
    // Scoped to the body subtree: both implementations stop the walk AT
    // `<html>`, so the root element deliberately has no selector at all.
    document.body.innerHTML = `<div><span>x</span><span>y</span><b>z</b><span>w</span></div>`
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const selector = cssSelector(el)
      expect(document.querySelector(selector)).toBe(el)
    }
  })
})
