/**
 * StreamLanguage parser drives a token classifier — drive it directly against
 * a real `StringStream` from @codemirror/language so we can assert the
 * classifier emits the right token names per slice of input.
 */

import { StringStream } from "@codemirror/language"
import { expressionStreamParser, workflowExpressionLanguage } from "./expression-language"

/**
 * Iterate the parser across `text`, returning a flat list of
 * `{ token, slice }` pairs. Whitespace tokens (returned as `null`) are
 * filtered out so assertions stay readable.
 */
function classify(text: string): Array<{ token: string | null; slice: string }> {
  const state = expressionStreamParser.startState!(2)
  const stream = new StringStream(text, 2, 2, 0)
  const out: Array<{ token: string | null; slice: string }> = []
  let safety = 0
  while (!stream.eol()) {
    safety += 1
    if (safety > 1000) throw new Error("classify: runaway loop")
    const start = stream.pos
    const token = expressionStreamParser.token(stream, state)
    if (stream.pos === start) {
      // Defensive — token() must always advance the stream.
      stream.next()
    }
    out.push({ token: token ?? null, slice: text.slice(start, stream.pos) })
  }
  return out
}

describe("expressionStreamParser", () => {
  it("emits literal text outside mustaches without a token name", () => {
    const tokens = classify("hello world")
    expect(tokens.every((t) => t.token === null)).toBe(true)
    expect(tokens.map((t) => t.slice).join("")).toBe("hello world")
  })

  it("marks the {{ and }} delimiters as punctuation.special", () => {
    const tokens = classify("{{ x }}")
    const open = tokens.find((t) => t.slice === "{{")
    const close = tokens.find((t) => t.slice === "}}")
    expect(open?.token).toBe("punctuation.special")
    expect(close?.token).toBe("punctuation.special")
  })

  it("recognises keyword idents inside a mustache", () => {
    const tokens = classify("{{ $node['n_a'].out.field }}")
    const types = tokens.filter((t) => t.slice === "$node" || t.slice === "out").map((t) => t.token)
    expect(types).toContain("keyword")
    expect(types).toContain("propertyName")
  })

  it("emits string tokens for both single- and double-quoted literals", () => {
    const single = classify("{{ $node['x'] }}")
    expect(single.find((t) => t.slice === "'x'")?.token).toBe("string")
    const dbl = classify('{{ $node["y"] }}')
    expect(dbl.find((t) => t.slice === '"y"')?.token).toBe("string")
  })

  it("classifies numbers and operators inside a mustache", () => {
    const tokens = classify("{{ a >= 42 }}")
    expect(tokens.find((t) => t.slice === "42")?.token).toBe("number")
    expect(tokens.find((t) => t.slice === ">=")?.token).toBe("operator")
  })

  it("classifies the other top-level keywords", () => {
    expect(classify("{{ $trigger }}").find((t) => t.slice === "$trigger")?.token).toBe("keyword")
    expect(classify("{{ $static }}").find((t) => t.slice === "$static")?.token).toBe("keyword")
    expect(classify("{{ $params }}").find((t) => t.slice === "$params")?.token).toBe("keyword")
  })

  it("treats unknown identifiers as variableName", () => {
    const tokens = classify("{{ foo }}")
    expect(tokens.find((t) => t.slice === "foo")?.token).toBe("variableName")
  })

  it("classifies bracket / dot punctuation", () => {
    const tokens = classify("{{ $node['x'][0] }}")
    expect(tokens.find((t) => t.slice === "[")?.token).toBe("punctuation")
    expect(tokens.find((t) => t.slice === "]")?.token).toBe("punctuation")
  })

  it("re-enters literal mode after a closing }}", () => {
    const tokens = classify("{{ $params }} trailing")
    const closeIdx = tokens.findIndex((t) => t.slice === "}}")
    expect(closeIdx).toBeGreaterThanOrEqual(0)
    const after = tokens.slice(closeIdx + 1)
    expect(after.every((t) => t.token === null)).toBe(true)
  })

  it("copyState produces an independent snapshot", () => {
    const a = expressionStreamParser.startState!(2)
    a.inMustache = true
    const b = expressionStreamParser.copyState!(a)
    b.inMustache = false
    expect(a.inMustache).toBe(true)
    expect(b.inMustache).toBe(false)
  })

  it("name field is set so CodeMirror panel can label the language", () => {
    expect(expressionStreamParser.name).toBe("workflowExpression")
  })
})

describe("workflowExpressionLanguage", () => {
  it("is constructed (StreamLanguage.define)", () => {
    expect(workflowExpressionLanguage).toBeDefined()
    // StreamLanguage.define returns a `LanguageSupport`-like object whose
    // `language` slot exposes the actual `Language` instance. We don't dig
    // deeper here; merely surfacing the export proves the module wires up.
  })
})
