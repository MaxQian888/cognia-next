/** @jest-environment jsdom */

import { MAX_SVG_CHARS, MermaidSvgTooLargeError, sanitizeMermaidSvg } from "./sanitize"

describe("sanitizeMermaidSvg", () => {
  it("keeps the shapes and text a diagram is made of", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">' +
      '<g class="node"><rect x="1" y="2" width="10" height="5" fill="#eee"/>' +
      '<path d="M0 0 L10 10"/><text x="4" y="6">Step one</text></g></svg>'

    const out = sanitizeMermaidSvg(svg)

    expect(out).toContain("<rect")
    expect(out).toContain("<path")
    expect(out).toContain("Step one")
    expect(out).toContain("viewBox")
  })

  it("keeps foreignObject HTML labels, which the stock SVG profile drops", () => {
    // This is what `securityLevel: "loose"` + htmlLabels actually emits. If
    // this assertion ever fails, every diagram renders with blank nodes.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<foreignObject width="80" height="20">' +
      '<div class="label"><span>first<br/>second</span></div>' +
      "</foreignObject></svg>"

    const out = sanitizeMermaidSvg(svg)

    expect(out).toContain("foreignObject")
    expect(out).toContain("first")
    expect(out).toContain("second")
    expect(out).toContain("<br")
  })

  it("strips a script smuggled through a label", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>' +
      "<div>ok<script>globalThis.__pwned = 1</script></div>" +
      "</foreignObject></svg>"

    const out = sanitizeMermaidSvg(svg)

    expect(out).toContain("ok")
    expect(out.toLowerCase()).not.toContain("<script")
    expect(out).not.toContain("__pwned")
  })

  it("strips inline event handlers", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<rect onclick="globalThis.__pwned = 1" onload="globalThis.__pwned = 2" width="4" height="4"/>' +
      "</svg>"

    const out = sanitizeMermaidSvg(svg)

    expect(out).toContain("<rect")
    expect(out.toLowerCase()).not.toContain("onclick")
    expect(out.toLowerCase()).not.toContain("onload")
  })

  it("strips a javascript: link target", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<a href="javascript:globalThis.__pwned=1"><text>click</text></a></svg>'

    const out = sanitizeMermaidSvg(svg)

    expect(out).toContain("click")
    expect(out.toLowerCase()).not.toContain("javascript:")
  })

  it("refuses an SVG large enough to block the main thread on parse", () => {
    const huge = `<svg>${"a".repeat(MAX_SVG_CHARS)}</svg>`

    expect(() => sanitizeMermaidSvg(huge)).toThrow(MermaidSvgTooLargeError)
    try {
      sanitizeMermaidSvg(huge)
    } catch (error) {
      expect((error as MermaidSvgTooLargeError).chars).toBe(huge.length)
      expect((error as Error).message).toContain(String(MAX_SVG_CHARS))
    }
  })

  it("accepts an SVG exactly at the limit", () => {
    const atLimit = "a".repeat(MAX_SVG_CHARS)

    expect(() => sanitizeMermaidSvg(atLimit)).not.toThrow()
  })
})
