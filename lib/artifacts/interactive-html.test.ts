/**
 * @jest-environment jsdom
 */

import {
  INTERACTIVE_HANDLER_ATTRIBUTE,
  buildHandlerWiringSource,
  compileInteractiveHtml,
  hasInteractiveContent,
} from "./interactive-html"

describe("compileInteractiveHtml", () => {
  it("lifts inline scripts out in document order and strips them from the markup", () => {
    const program = compileInteractiveHtml(
      "<html><body><script>var a = 1</script><p>x</p><script>var b = 2</script></body></html>"
    )
    expect(program.scripts.map((s) => s.code)).toEqual(["var a = 1", "var b = 2"])
    expect(program.html).not.toContain("<script")
    expect(program.html).toContain("<p>x</p>")
  })

  it("rewrites an inline handler into addEventListener and marks its element", () => {
    const program = compileInteractiveHtml(
      `<html><body><button onclick="count++">go</button></body></html>`
    )
    expect(program.html).toContain(`${INTERACTIVE_HANDLER_ATTRIBUTE}="0"`)
    expect(program.html).not.toContain("onclick")
    const wiring = program.scripts.at(-1)?.code ?? ""
    expect(wiring).toContain(`querySelector("[${INTERACTIVE_HANDLER_ATTRIBUTE}=\\"0\\"]")`)
    expect(wiring).toContain('addEventListener("click"')
    expect(wiring).toContain("count++")
  })

  it("keeps handler bodies as SOURCE, never as a string to eval", () => {
    // `new Function` / `eval` would need 'unsafe-eval', which the shell CSP
    // does not grant — the whole point of emitting source.
    const program = compileInteractiveHtml(
      `<html><body><a href="#" onclick="go()">a</a></body></html>`
    )
    const wiring = program.scripts.at(-1)?.code ?? ""
    expect(wiring).not.toContain("new Function")
    expect(wiring).not.toMatch(/\beval\(/)
  })

  it("wires several handlers on one element under a single marker", () => {
    const program = compileInteractiveHtml(
      `<html><body><input onfocus="f()" onblur="b()"></body></html>`
    )
    const wiring = program.scripts.at(-1)?.code ?? ""
    expect(wiring).toContain('addEventListener("focus"')
    expect(wiring).toContain('addEventListener("blur"')
    expect(program.html.match(new RegExp(INTERACTIVE_HANDLER_ATTRIBUTE, "g"))).toHaveLength(1)
  })

  it("drops an external script and reports it instead of failing silently", () => {
    const program = compileInteractiveHtml(
      `<html><body><script src="https://cdn.example/x.js"></script></body></html>`
    )
    expect(program.droppedExternalScripts).toEqual(["https://cdn.example/x.js"])
    expect(program.scripts).toEqual([])
  })

  it("marks a module script so the frame gives it type=module", () => {
    const program = compileInteractiveHtml(
      `<html><body><script type="module">export const a = 1</script></body></html>`
    )
    expect(program.scripts).toEqual([{ code: "export const a = 1", module: true }])
  })

  it("does not execute a non-JavaScript script block", () => {
    const program = compileInteractiveHtml(
      `<html><body><script type="application/json">{"a":1}</script></body></html>`
    )
    expect(program.scripts).toEqual([])
  })

  it("keeps form controls, which is the point of the interactive mode", () => {
    const program = compileInteractiveHtml(
      `<html><body><form><input name="q"><button>Go</button><select><option>1</option></select></form></body></html>`
    )
    expect(program.html).toContain("<form")
    expect(program.html).toContain("<input")
    expect(program.html).toContain("<button")
    expect(program.html).toContain("<select")
  })

  it("refuses an artifact-supplied CSP meta and any nested browsing context", () => {
    const program = compileInteractiveHtml(
      `<html><head><meta http-equiv="Content-Security-Policy" content="script-src *"></head>` +
        `<body><iframe src="https://evil.example"></iframe><object data="x"></object></body></html>`
    )
    expect(program.html).not.toContain("http-equiv")
    expect(program.html).not.toContain("<iframe")
    expect(program.html).not.toContain("<object")
  })

  it("emits a doctype so the frame parses in standards mode", () => {
    expect(
      compileInteractiveHtml("<html><body>x</body></html>").html.startsWith("<!DOCTYPE html>")
    ).toBe(true)
  })
})

describe("buildHandlerWiringSource", () => {
  it("is empty when there is nothing to wire", () => {
    expect(buildHandlerWiringSource([])).toBe("")
  })

  it("guards against a missing element rather than throwing", () => {
    const source = buildHandlerWiringSource([{ id: "0", event: "click", body: "x()" }])
    expect(source).toContain("if (!target) return;")
  })
})

describe("hasInteractiveContent", () => {
  it("spots scripts, handlers and forms", () => {
    expect(hasInteractiveContent("<script>x</script>")).toBe(true)
    expect(hasInteractiveContent('<button onclick="x()">')).toBe(true)
    expect(hasInteractiveContent("<form></form>")).toBe(true)
  })

  it("is false for a document with nothing to run", () => {
    expect(hasInteractiveContent("<h1>Report</h1><p>text</p>")).toBe(false)
  })
})
