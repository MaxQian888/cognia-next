import { parseSegments } from "@/lib/slash-commands/parse-segments"
import { computeCodeRanges } from "./code-ranges"
import { listParamIds, listParamTokens, splitParamSegments } from "./param-segments"

const noCommands = () => false

/** The full overlay view: commands, mentions and parameters in one list. */
function overlay(text: string, isKnownCommand: (name: string) => boolean = noCommands) {
  return splitParamSegments(
    parseSegments(text, isKnownCommand, { mentions: true }),
    computeCodeRanges(text)
  )
}

describe("listParamTokens", () => {
  it("finds tokens with their absolute source range", () => {
    const input = "review {{module}} now"

    expect(listParamTokens(input)).toEqual([
      { kind: "param", paramId: "module", raw: "{{module}}", start: 7, end: 17 },
    ])
  })

  it("trims inner whitespace so two spellings are one parameter", () => {
    expect(listParamTokens("{{ module }} and {{module}}").map((t) => t.paramId)).toEqual([
      "module",
      "module",
    ])
  })

  it("accepts dotted, dashed and colon-separated ids", () => {
    expect(
      listParamTokens("{{repo.name}} {{base-ref}} {{issue:id}}").map((t) => t.paramId)
    ).toEqual(["repo.name", "base-ref", "issue:id"])
  })

  it("ignores a token whose id does not start and end alphanumeric", () => {
    expect(listParamTokens("{{.leading}} {{trailing-}} {{}}")).toEqual([])
  })

  it("ignores an id longer than the platform's identifier limit", () => {
    expect(listParamTokens(`{{${"a".repeat(129)}}}`)).toEqual([])
    expect(listParamTokens(`{{${"a".repeat(128)}}}`)).toHaveLength(1)
  })

  it("reads the inner pair when braces are tripled, leaving the outer ones as text", () => {
    expect(listParamTokens("{{{x}}}")).toEqual([
      { kind: "param", paramId: "x", raw: "{{x}}", start: 1, end: 6 },
    ])
  })

  it("skips tokens inside code", () => {
    const input = "set {{live}} then:\n```\n{{ jinja }}\n```\nand `{{inline}}`"

    expect(listParamTokens(input, computeCodeRanges(input)).map((t) => t.paramId)).toEqual(["live"])
  })

  it("does not carry regex state between calls", () => {
    // A shared `g` regex keeps `lastIndex`, so the second call would start
    // mid-string and silently lose the first token. This module runs on every
    // keystroke, so that failure would be intermittent and awful to find.
    expect(listParamTokens("{{a}}")).toHaveLength(1)
    expect(listParamTokens("{{a}}")).toHaveLength(1)
  })
})

describe("listParamIds", () => {
  it("de-duplicates in first-appearance order", () => {
    expect(listParamIds("{{b}} {{a}} {{b}}")).toEqual(["b", "a"])
  })
})

describe("splitParamSegments", () => {
  it("splits a parameter out of surrounding text, staying contiguous", () => {
    const segments = overlay("fix {{module}} please")

    expect(segments).toEqual([
      { kind: "text", value: "fix ", start: 0, end: 4 },
      { kind: "param", paramId: "module", raw: "{{module}}", start: 4, end: 14 },
      { kind: "text", value: " please", start: 14, end: 21 },
    ])
  })

  it("covers the whole input with no gaps or overlaps", () => {
    const input = "a {{x}} b @file.ts c {{y}}"
    const segments = overlay(input)

    let cursor = 0
    for (const seg of segments) {
      expect(seg.start).toBe(cursor)
      cursor = seg.end
    }
    expect(cursor).toBe(input.length)
  })

  it("keeps mention pills alongside parameter pills", () => {
    const kinds = overlay("@src/a.ts uses {{module}}").map((s) => s.kind)

    expect(kinds).toEqual(["mention", "text", "param"])
  })

  it("leaves a parameter inside a command's arguments alone", () => {
    // Command args go to `applyTemplate`, which runs its own `$1` /
    // `$ARGUMENTS` substitution. Two substitution passes over one string is how
    // a value containing `$1` gets mangled.
    const segments = overlay("/review {{module}}", (name) => name === "review")

    expect(segments).toEqual([
      {
        kind: "command",
        name: "review",
        args: "{{module}}",
        raw: "/review {{module}}",
        start: 0,
        end: 18,
      },
    ])
  })

  it("paints nothing inside a fenced block", () => {
    const input = "before {{live}}\n```yaml\nname: {{ jinja }}\n```"
    const params = overlay(input).filter((s) => s.kind === "param")

    expect(params).toEqual([{ kind: "param", paramId: "live", raw: "{{live}}", start: 7, end: 15 }])
  })

  it("returns the segment untouched when it holds no parameter", () => {
    const parsed = parseSegments("plain text", noCommands, { mentions: true })

    expect(splitParamSegments(parsed, [])).toEqual(parsed)
  })

  it("re-bases code ranges onto each text segment's own coordinates", () => {
    // The masked span sits after a command line, so the text segment carrying
    // it starts at a non-zero offset — a splitter that forgot to re-base would
    // mask the wrong characters.
    const input = "/reset\ntail `{{ masked }}` and {{live}}"
    const params = overlay(input, (name) => name === "reset").filter((s) => s.kind === "param")

    expect(params.map((s) => s.kind === "param" && s.paramId)).toEqual(["live"])
  })
})
