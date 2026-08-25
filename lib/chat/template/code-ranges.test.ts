import { computeCodeRanges, isInCodeRange } from "./code-ranges"

/** The masked substrings, which is what every caller actually cares about. */
function masked(input: string): string[] {
  return computeCodeRanges(input).map((range) => input.slice(range.start, range.end))
}

describe("computeCodeRanges", () => {
  it("finds nothing in ordinary prose", () => {
    expect(computeCodeRanges("review {{module}} and report back")).toEqual([])
  })

  it("masks a fenced block including both fence lines", () => {
    const input = "before\n```ts\nconst a = {{ x }}\n```\nafter"

    expect(masked(input)).toEqual(["```ts\nconst a = {{ x }}\n```"])
  })

  it("masks a fence that is never closed, to the end of the input", () => {
    // A block you are halfway through typing is still a block. Sprouting pills
    // inside it and retracting them once the closing fence lands is worse than
    // being briefly conservative.
    const input = "here:\n```\n{{ still typing }}"

    expect(masked(input)).toEqual(["```\n{{ still typing }}"])
  })

  it("does not let a shorter run close a longer fence", () => {
    const input = "````\n```\n{{ inner }}\n````\ntail"

    expect(masked(input)).toEqual(["````\n```\n{{ inner }}\n````"])
  })

  it("lets a longer run close a shorter fence", () => {
    const input = "```\n{{ inner }}\n````\ntail"

    expect(masked(input)).toEqual(["```\n{{ inner }}\n````"])
  })

  it("does not let a tilde fence close a backtick fence", () => {
    const input = "```\n~~~\n{{ inner }}\n```\ntail"

    expect(masked(input)).toEqual(["```\n~~~\n{{ inner }}\n```"])
  })

  it("recognises an indented fence line", () => {
    const input = "  ```\n  {{ x }}\n  ```\n"

    expect(masked(input)).toEqual(["  ```\n  {{ x }}\n  ```"])
  })

  it("handles CRLF line endings", () => {
    const input = "a\r\n```\r\n{{ x }}\r\n```\r\nb"

    expect(masked(input)).toEqual(["```\r\n{{ x }}\r\n```"])
  })

  it("masks an inline span", () => {
    const input = "use `{{ x }}` here"

    expect(masked(input)).toEqual(["`{{ x }}`"])
  })

  it("matches inline runs by equal length, so a double span may contain a backtick", () => {
    const input = "``a ` b`` tail"

    expect(masked(input)).toEqual(["``a ` b``"])
  })

  it("leaves an unmatched backtick as ordinary text", () => {
    // One stray backtick must not silently disable parameters for the rest of
    // the message.
    expect(computeCodeRanges("costs ` {{ amount }} dollars")).toEqual([])
  })

  it("does not match an inline span across a line break", () => {
    expect(computeCodeRanges("open `\n{{ x }}\nclose `")).toEqual([])
  })

  it("finds several spans on one line, ascending and non-overlapping", () => {
    const input = "`a` and `b`"

    expect(masked(input)).toEqual(["`a`", "`b`"])
    const ranges = computeCodeRanges(input)
    expect(ranges[0].end).toBeLessThanOrEqual(ranges[1].start)
  })

  it("ignores inline backticks inside a fenced block", () => {
    // Inside a fence the whole block is already masked; a stray backtick there
    // must not produce a second, overlapping range.
    const input = "```\nlet x = `t`\n```"

    expect(masked(input)).toEqual(["```\nlet x = `t`\n```"])
  })
})

describe("isInCodeRange", () => {
  const input = "before\n```\n{{ x }}\n```\ntail `{{ y }}` and {{ z }}"
  const ranges = computeCodeRanges(input)

  it("reports a token wholly inside a masked span", () => {
    const y = input.indexOf("{{ y }}")
    expect(isInCodeRange(ranges, y, y + "{{ y }}".length)).toBe(true)
  })

  it("reports a token outside every masked span", () => {
    const z = input.indexOf("{{ z }}")
    expect(isInCodeRange(ranges, z, z + "{{ z }}".length)).toBe(false)
  })

  it("does not treat a token that merely overlaps a span as inside it", () => {
    expect(isInCodeRange([{ start: 4, end: 10 }], 8, 14)).toBe(false)
  })
})
