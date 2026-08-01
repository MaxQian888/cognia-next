import {
  generateSkillFromEnvelope,
  normalizeDraft,
  parseSkillJson,
  sanitizeName,
  stripFences,
} from "./generate-skill"
import type { GenerationEnvelope } from "./generation-envelope"

const ENVELOPE: GenerationEnvelope = {
  systemPrompt: "SYSTEM",
  userPrompt: "USER",
  redacted: false,
  truncatedSteps: 0,
  describedSteps: 2,
}

const GOOD = JSON.stringify({
  name: "Monthly export",
  description: "Exports invoices.",
  content: "## Steps\n1. Go",
  tags: ["billing"],
  category: "productivity",
  allowedTools: ["Read", "Teleport"],
})

function client(reply: string | Error) {
  return {
    complete: jest.fn(async () => {
      if (reply instanceof Error) throw reply
      return reply
    }),
  }
}

describe("stripFences", () => {
  it("unwraps a fenced block, with or without a language tag", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it("leaves unfenced text alone", () => {
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}')
  })
})

describe("parseSkillJson", () => {
  it("parses clean JSON", () => {
    expect(parseSkillJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("recovers the object from surrounding prose", () => {
    expect(parseSkillJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 })
  })

  it("throws when there is no object at all", () => {
    expect(() => parseSkillJson("I could not do that.")).toThrow(/valid JSON/)
  })

  it("throws when the braces enclose broken JSON", () => {
    expect(() => parseSkillJson("{not json}")).toThrow()
  })
})

describe("sanitizeName", () => {
  it("keeps alphanumerics, spaces, underscore and dash", () => {
    expect(sanitizeName("Export_2024 - final", "fb")).toBe("Export_2024 - final")
  })

  it("replaces anything else with a single space", () => {
    expect(sanitizeName("Export/invoices (v2)", "fb")).toBe("Export invoices v2")
  })

  it("truncates to 64 characters", () => {
    expect(sanitizeName("a".repeat(80), "fb")).toHaveLength(64)
  })

  it("falls back when nothing usable survives", () => {
    expect(sanitizeName("///", "fb")).toBe("fb")
    expect(sanitizeName(undefined, "fb")).toBe("fb")
    expect(sanitizeName(42, "fb")).toBe("fb")
  })
})

describe("normalizeDraft", () => {
  it("keeps a known category and defaults an invented one to custom", () => {
    expect(normalizeDraft({ content: "x", category: "productivity" }, "fb").category).toBe(
      "productivity"
    )
    expect(normalizeDraft({ content: "x", category: "teleportation" }, "fb").category).toBe(
      "custom"
    )
  })

  it("refuses a draft with no body", () => {
    // An empty skill saves cleanly and does nothing — the worst failure mode.
    expect(() => normalizeDraft({ content: "   " }, "fb")).toThrow(/no content/)
    expect(() => normalizeDraft({}, "fb")).toThrow(/no content/)
  })

  it("drops non-string and blank entries from the string arrays", () => {
    const draft = normalizeDraft(
      { content: "x", tags: ["a", 1, "", "  ", "b"], allowedTools: ["Read", null] },
      "fb"
    )
    expect(draft.tags).toEqual(["a", "b"])
    expect(draft.allowedTools).toEqual(["Read"])
  })

  it("defaults a missing description to empty rather than inventing one", () => {
    expect(normalizeDraft({ content: "x" }, "fb").description).toBe("")
  })
})

describe("generateSkillFromEnvelope", () => {
  it("sends the envelope's strings verbatim — nothing is rebuilt here", () => {
    // The preview the user approved *is* these two strings. Re-deriving either
    // would make that preview a lie.
    const llm = client(GOOD)
    return generateSkillFromEnvelope(ENVELOPE, llm, {
      toolCatalog: ["Read"],
      fallbackName: "fb",
    }).then(() => {
      expect(llm.complete).toHaveBeenCalledWith(
        "USER",
        expect.objectContaining({ system: "SYSTEM" })
      )
    })
  })

  it("keeps only tools that exist, and reports the rest", async () => {
    const result = await generateSkillFromEnvelope(ENVELOPE, client(GOOD), {
      toolCatalog: ["Read"],
      fallbackName: "fb",
    })
    expect(result.draft.allowedTools).toEqual(["Read"])
    expect(result.tools.unknown).toEqual(["Teleport"])
  })

  it("reports whether redaction altered the transcript", async () => {
    const result = await generateSkillFromEnvelope({ ...ENVELOPE, redacted: true }, client(GOOD), {
      toolCatalog: ["Read"],
      fallbackName: "fb",
    })
    expect(result.redacted).toBe(true)
  })

  it("accepts a fenced reply", async () => {
    const result = await generateSkillFromEnvelope(ENVELOPE, client("```json\n" + GOOD + "\n```"), {
      toolCatalog: [],
      fallbackName: "fb",
    })
    expect(result.draft.name).toBe("Monthly export")
  })

  it("propagates a model failure so the manual path can take over", async () => {
    await expect(
      generateSkillFromEnvelope(ENVELOPE, client(new Error("no provider")), {
        toolCatalog: [],
        fallbackName: "fb",
      })
    ).rejects.toThrow("no provider")
  })

  it("propagates an unparsable reply", async () => {
    await expect(
      generateSkillFromEnvelope(ENVELOPE, client("sorry, I can't"), {
        toolCatalog: [],
        fallbackName: "fb",
      })
    ).rejects.toThrow(/valid JSON/)
  })

  it("uses the fallback name when the model omits one", async () => {
    const result = await generateSkillFromEnvelope(
      ENVELOPE,
      client(JSON.stringify({ content: "## Steps\n1. Go" })),
      { toolCatalog: [], fallbackName: "Recorded skill" }
    )
    expect(result.draft.name).toBe("Recorded skill")
  })
})
