import {
  PROMPT_PREAMBLE_FRAMING,
  carryPromptPreamble,
  chipCitationsOf,
  composeTurnText,
  locatePromptPreamble,
  promptPreambleInnerText,
  promptPreambleOfParts,
  readPromptPreambleSummary,
  splitPromptPreamble,
  stripPromptPreamble,
  stripPromptPreambleFromContent,
  stripPromptPreambleFromParts,
  summarizeSelectionForPreamble,
} from "./prompt-preamble"

const NONCE = "abc123def4"

describe("composeTurnText", () => {
  it("returns the typed text untouched when nothing is attached", () => {
    expect(composeTurnText("hello", [], { nonce: NONCE })).toEqual({
      text: "hello",
      preamble: "",
      sections: [],
    })
    // Blank sections count as nothing attached, too.
    expect(composeTurnText("hi", [{ kind: "references", text: "  " }], { nonce: NONCE }).text).toBe(
      "hi"
    )
  })

  it("wraps sections in a nonce-tagged envelope in a fixed order", () => {
    const out = composeTurnText(
      "what changed?",
      [
        { kind: "webSearch", text: "web results" },
        { kind: "references", text: "Referenced context:\n\nplan" },
        { kind: "reviewReceipts", text: "receipts" },
      ],
      { nonce: NONCE }
    )
    expect(out.sections).toEqual(["reviewReceipts", "references", "webSearch"])
    expect(out.text).toBe(
      [
        `<cognia_context_${NONCE}>`,
        PROMPT_PREAMBLE_FRAMING,
        "",
        "receipts\n\n---\n\nReferenced context:\n\nplan\n\n---\n\nweb results",
        `</cognia_context_${NONCE}>`,
        "",
        "what changed?",
      ].join("\n")
    )
    expect(out.text.startsWith(out.preamble)).toBe(true)
  })

  it("sends the envelope alone when only references were staged", () => {
    const out = composeTurnText("   ", [{ kind: "references", text: "ctx" }], { nonce: NONCE })
    expect(out.text).toBe(out.preamble)
  })

  it("draws a fresh nonce per turn by default", () => {
    const a = composeTurnText("x", [{ kind: "references", text: "ctx" }]).preamble
    const b = composeTurnText("x", [{ kind: "references", text: "ctx" }]).preamble
    expect(a).toMatch(/^<cognia_context_[0-9a-z]{6,32}>\n/)
    expect(a).not.toBe(b)
  })
})

describe("splitPromptPreamble", () => {
  const composed = composeTurnText("line one\nline two", [{ kind: "references", text: "body" }], {
    nonce: NONCE,
  })

  it("round-trips the typed text", () => {
    expect(splitPromptPreamble(composed.text)).toEqual({
      preamble: composed.preamble,
      body: "line one\nline two",
    })
    expect(stripPromptPreamble(composed.text)).toBe("line one\nline two")
  })

  it("leaves text without an envelope alone", () => {
    expect(splitPromptPreamble("Referenced context: typed by hand")).toEqual({
      preamble: null,
      body: "Referenced context: typed by hand",
    })
  })

  it("does not end the block at a closing tag with a different nonce", () => {
    const tricky = composeTurnText(
      "question",
      [{ kind: "references", text: "a doc quoting </cognia_context_zzzzzz999> inline" }],
      { nonce: NONCE }
    )
    expect(stripPromptPreamble(tricky.text)).toBe("question")
  })

  it("returns an unclosed envelope whole instead of swallowing the message", () => {
    const unclosed = `<cognia_context_${NONCE}>\nno closing tag\n\nmy words`
    expect(splitPromptPreamble(unclosed)).toEqual({ preamble: null, body: unclosed })
  })

  it("only recognises an envelope at the very start", () => {
    const quoted = `see this:\n${composed.text}`
    expect(stripPromptPreamble(quoted)).toBe(quoted)
  })

  it("exposes the sections without tags or framing", () => {
    expect(promptPreambleInnerText(composed.preamble)).toBe("body")
  })
})

describe("parts helpers", () => {
  const composed = composeTurnText("typed", [{ kind: "references", text: "ctx" }], {
    nonce: NONCE,
  })

  it("strips only the first text part and keeps file parts in place", () => {
    const parts = [
      { type: "file", url: "data:x" },
      { type: "text", text: composed.text, state: "done" },
      { type: "text", text: composed.text },
    ]
    const out = stripPromptPreambleFromParts(parts)
    expect(out).toEqual([
      { type: "file", url: "data:x" },
      { type: "text", text: "typed", state: "done" },
      // A later part that merely quotes an envelope is not the preamble.
      { type: "text", text: composed.text },
    ])
    expect(promptPreambleOfParts(parts)).toBe(composed.preamble)
  })

  it("drops a part that was nothing but the envelope", () => {
    const onlyRefs = composeTurnText("", [{ kind: "references", text: "ctx" }], { nonce: NONCE })
    expect(stripPromptPreambleFromParts([{ type: "text", text: onlyRefs.text }])).toEqual([])
  })

  it("returns the same array when there is nothing to strip", () => {
    const parts = [{ type: "text", text: "plain" }]
    expect(stripPromptPreambleFromParts(parts)).toBe(parts)
    expect(promptPreambleOfParts(parts)).toBeNull()
    expect(promptPreambleOfParts("not parts")).toBeNull()
  })

  it("strips SendContent strings and blocks", () => {
    expect(stripPromptPreambleFromContent(composed.text)).toBe("typed")
    expect(
      stripPromptPreambleFromContent([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
        { type: "text", text: composed.text },
      ] as never)
    ).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      { type: "text", text: "typed" },
    ])
  })
})

describe("summary", () => {
  it("names a selection without carrying its body", () => {
    expect(
      summarizeSelectionForPreamble({
        kind: "entity",
        entityKind: "message",
        entityId: "s#m",
        title: "3 messages",
        snapshot: "SECRET BODY",
        comment: "",
        capturedAt: 1,
        href: "/?session=s&message=m",
        members: [
          { entityId: "s#m", title: "a" },
          { entityId: "s#n", title: "b" },
          { entityId: "s#o", title: "c" },
        ],
      })
    ).toEqual({
      kind: "entity",
      entityKind: "message",
      title: "3 messages",
      href: "/?session=s&message=m",
      count: 3,
    })
    expect(
      summarizeSelectionForPreamble({
        kind: "file",
        relPath: "src/a.ts",
        title: "a.ts",
        snapshot: "x",
        comment: "",
      })
    ).toEqual({ kind: "file", title: "src/a.ts" })
  })

  it("reads persisted summaries defensively", () => {
    expect(readPromptPreambleSummary(undefined)).toBeNull()
    expect(readPromptPreambleSummary({ promptPreamble: "nope" })).toBeNull()
    expect(
      readPromptPreambleSummary({
        promptPreamble: {
          sections: ["references", "bogus", 3],
          references: [
            { kind: "entity", entityKind: "issue", title: "COG-1", href: "/issues?id=1", count: 1 },
            { kind: "file" },
            null,
          ],
        },
      })
    ).toEqual({
      sections: ["references"],
      references: [{ kind: "entity", entityKind: "issue", title: "COG-1", href: "/issues?id=1" }],
    })
  })
})

describe("carryPromptPreamble", () => {
  const original = composeTurnText("compare these", [{ kind: "references", text: "A and B" }], {
    nonce: "c0ffee1234",
  })
  const parts = [{ type: "text", text: original.text }]

  // Every edit surface drafts from the typed text, so the references would be
  // lost on re-send without this.
  it("puts the original envelope back in front of the edited text", () => {
    const carried = carryPromptPreamble(parts, "compare them again") as string
    expect(splitPromptPreamble(carried)).toEqual({
      preamble: original.preamble,
      body: "compare them again",
    })
  })

  it("carries into block content and into an empty edit", () => {
    expect(carryPromptPreamble(parts, [{ type: "text", text: "again" }] as never)).toEqual([
      { type: "text", text: `${original.preamble}\n\nagain` },
    ])
    expect(carryPromptPreamble(parts, "   ")).toBe(original.preamble)
  })

  it("carries onto the typed block past the attachments, never onto a file's text", () => {
    // An extracted document is a text block too, and leads the content.
    const file = { type: "text" as const, text: "Q3 revenue grew 12%." }
    expect(carryPromptPreamble(parts, [file, { type: "text", text: "again" }], 1)).toEqual([
      file,
      { type: "text", text: `${original.preamble}\n\nagain` },
    ])
    // Nothing typed: the envelope takes the typed block's place after the files.
    expect(carryPromptPreamble(parts, [file], 1)).toEqual([
      file,
      { type: "text", text: original.preamble },
    ])
  })

  it("leaves content alone when the original had no envelope or the edit has one", () => {
    expect(carryPromptPreamble([{ type: "text", text: "plain" }], "edited")).toBe("edited")
    expect(carryPromptPreamble(parts, original.text)).toBe(original.text)
  })
})

describe("chipCitationsOf", () => {
  it("keeps only the citations a chip made, not re-parsed tokens", () => {
    expect(
      chipCitationsOf({
        mentions: [
          { kind: "file", id: "src/a.ts" },
          { kind: "entity", id: "issue:i1", label: "Bug" },
          { kind: "doc", id: "lark:d1" },
          { kind: "entity" },
        ],
      })
    ).toEqual([
      { kind: "entity", id: "issue:i1", label: "Bug" },
      { kind: "doc", id: "lark:d1" },
    ])
    expect(chipCitationsOf(undefined)).toEqual([])
  })
})

describe("locatePromptPreamble", () => {
  it("names the part index without removing it", () => {
    const turn = composeTurnText("hi", [{ kind: "references", text: "ctx" }], { nonce: NONCE })
    const parts = [{ type: "file" }, { type: "text", text: turn.text }]
    expect(locatePromptPreamble(parts)).toEqual({ index: 1, preamble: turn.preamble, body: "hi" })
    expect(parts).toHaveLength(2)
    expect(locatePromptPreamble([{ type: "text", text: "plain" }])).toBeNull()
    expect(locatePromptPreamble(null)).toBeNull()
  })
})
