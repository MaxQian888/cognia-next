import { parseSegments } from "@/lib/slash-commands/parse-segments"
import type { ParamSegment } from "@/lib/slash-commands/parse-segments"
import { computeCodeRanges } from "./code-ranges"
import { splitParamSegments } from "./param-segments"
import { renderParamTokens } from "./render-params"
import type { ChatTemplateBinding, ChatTemplateParamValue } from "./binding"

const known = (name: string) => ["review"].includes(name)

/** The chip ranges the composer would hand this function. */
function tokensOf(text: string): ParamSegment[] {
  return splitParamSegments(
    parseSegments(text, known, { mentions: true }),
    computeCodeRanges(text)
  ).filter((seg): seg is ParamSegment => seg.kind === "param")
}

function binding(params: Record<string, ChatTemplateParamValue>): ChatTemplateBinding {
  return { templateId: "t", version: "1.0.0", params, insertedAt: 1 }
}

const text = (value: string): ChatTemplateParamValue => ({ kind: "text", value })

describe("renderParamTokens", () => {
  it("substitutes a filled parameter", () => {
    const input = "review {{module}} please"

    expect(renderParamTokens(input, tokensOf(input), binding({ module: text("login") }))).toEqual({
      text: "review login please",
      changed: true,
    })
  })

  it("substitutes every occurrence of the same parameter", () => {
    const input = "{{who}} asked {{who}} twice"

    expect(renderParamTokens(input, tokensOf(input), binding({ who: text("Ada") })).text).toBe(
      "Ada asked Ada twice"
    )
  })

  it("contributes a resource's label, not its id", () => {
    const input = "open {{repo}}"
    const value: ChatTemplateParamValue = {
      kind: "resource",
      resourceKind: "repo",
      id: "p_a1b2",
      label: "cognia-next",
    }

    expect(renderParamTokens(input, tokensOf(input), binding({ repo: value })).text).toBe(
      "open cognia-next"
    )
  })

  it("leaves an unfilled parameter as its literal token", () => {
    // Collapsing it to nothing would produce a sentence with a hole that reads
    // as finished. A visible `{{module}}` is the better failure.
    const input = "review {{module}}"

    expect(renderParamTokens(input, tokensOf(input), binding({}))).toEqual({
      text: "review {{module}}",
      changed: false,
    })
  })

  it("leaves code alone, because the chip pass already excluded it", () => {
    const input = "set {{live}}\n```\nname: {{live}}\n```"

    expect(renderParamTokens(input, tokensOf(input), binding({ live: text("on") })).text).toBe(
      "set on\n```\nname: {{live}}\n```"
    )
  })

  it("leaves a command's arguments to applyTemplate's own pass", () => {
    // `/review {{module}}` is not a chip, so this function must not touch it —
    // two substitution engines over one string is how a value containing `$1`
    // gets mangled.
    const input = "/review {{module}}"

    expect(renderParamTokens(input, tokensOf(input), binding({ module: text("login") })).text).toBe(
      "/review {{module}}"
    )
  })

  it("is a no-op with no tokens", () => {
    expect(renderParamTokens("just prose", [], binding({}))).toEqual({
      text: "just prose",
      changed: false,
    })
  })

  it("does not duplicate a slice when handed out-of-order ranges", () => {
    const input = "{{a}} then {{b}}"
    const reversed = [...tokensOf(input)].reverse()

    expect(
      renderParamTokens(input, reversed, binding({ a: text("one"), b: text("two") })).text
    ).toBe("one then two")
  })

  it("reports changed=false when a value renders identically to its token", () => {
    // Pathological, but `changed` drives whether the caller re-parses; claiming
    // a change that did not happen would cost a needless re-parse, and missing
    // one would leave stale segments.
    const input = "{{a}}"

    expect(renderParamTokens(input, tokensOf(input), binding({ a: text("{{a}}") })).changed).toBe(
      false
    )
  })
})
