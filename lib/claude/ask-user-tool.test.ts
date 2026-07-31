import {
  ASK_USER_TOOL_NAME,
  buildAskUserManifestEntry,
  parseAskUserArgs,
  formatAskUserAnswer,
  type AskUserRequest,
} from "./ask-user-tool"

describe("buildAskUserManifestEntry", () => {
  it("surfaces the ask_user tool with an object schema", () => {
    const entry = buildAskUserManifestEntry()
    expect(entry.name).toBe(ASK_USER_TOOL_NAME)
    expect(entry.pluginId).toBe("cognia-ask-user")
    expect((entry.jsonSchema as { type?: string }).type).toBe("object")
    expect(entry.description.length).toBeGreaterThan(0)
  })

  it("disables the round-trip timeout so a slow human answer is never severed", () => {
    expect(buildAskUserManifestEntry().timeoutMs).toBe(0)
  })
})

describe("parseAskUserArgs", () => {
  it("keeps a valid question + well-formed options", () => {
    const r = parseAskUserArgs({
      question: "Pick one",
      options: [
        { value: "a", label: "Apple" },
        { value: "b", label: "Banana" },
      ],
    })
    expect(r.question).toBe("Pick one")
    expect(r.options).toEqual([
      { value: "a", label: "Apple" },
      { value: "b", label: "Banana" },
    ])
    // Options present → free text off by default.
    expect(r.allowText).toBe(false)
    expect(r.multiSelect).toBe(false)
  })

  it("falls back to the value when an option has no label", () => {
    const r = parseAskUserArgs({ question: "q", options: [{ value: "x" }] })
    expect(r.options).toEqual([{ value: "x", label: "x" }])
  })

  it("drops malformed options (no string value)", () => {
    const r = parseAskUserArgs({
      question: "q",
      options: [{ label: "no value" }, null, "nope", { value: 5 }],
    })
    expect(r.options).toEqual([])
  })

  it("defaults to free text when there are no options", () => {
    const r = parseAskUserArgs({ question: "q" })
    expect(r.allowText).toBe(true)
  })

  it("substitutes a placeholder for a missing / blank question", () => {
    expect(parseAskUserArgs({}).question).toBe("(no question provided)")
    expect(parseAskUserArgs({ question: "   " }).question).toBe("(no question provided)")
  })

  it("honours explicit multiSelect / allowText flags", () => {
    const r = parseAskUserArgs({
      question: "q",
      options: [{ value: "a", label: "A" }],
      multiSelect: true,
      allowText: true,
    })
    expect(r.multiSelect).toBe(true)
    expect(r.allowText).toBe(true)
  })
})

describe("formatAskUserAnswer", () => {
  const request: AskUserRequest = {
    question: "Pick",
    options: [
      { value: "a", label: "Apple" },
      { value: "b", label: "Banana" },
    ],
    multiSelect: true,
    allowText: true,
  }

  it("reports a cancellation distinctly", () => {
    expect(formatAskUserAnswer(request, { selected: [], text: "", cancelled: true })).toMatch(
      /dismissed/
    )
  })

  it("renders selected labels and free text together", () => {
    const out = formatAskUserAnswer(request, {
      selected: ["a", "b"],
      text: "also this",
      cancelled: false,
    })
    expect(out).toContain("Apple, Banana")
    expect(out).toContain("also this")
  })

  it("falls back to the raw value when a selection has no matching option", () => {
    const out = formatAskUserAnswer(request, { selected: ["zzz"], text: "", cancelled: false })
    expect(out).toContain("zzz")
  })

  it("flags an empty submission", () => {
    expect(formatAskUserAnswer(request, { selected: [], text: "  ", cancelled: false })).toMatch(
      /empty/
    )
  })
})
