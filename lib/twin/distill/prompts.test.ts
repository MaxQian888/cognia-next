import {
  applyTemplate,
  EVALUATOR_PROMPT,
  KNOWLEDGE_AGENT_PROMPT,
  PLAYBOOK_AGENT_PROMPT,
  STYLE_AGENT_PROMPT,
  SYNTHESIZER_PROMPT,
} from "./prompts"

describe("applyTemplate", () => {
  it("substitutes a single placeholder", () => {
    expect(applyTemplate("Hello, {name}!", { name: "Alice" })).toBe("Hello, Alice!")
  })

  it("substitutes multiple placeholders in one pass", () => {
    expect(applyTemplate("{greet}, {name}!", { greet: "Hi", name: "Bob" })).toBe("Hi, Bob!")
  })

  it("repeats the same placeholder everywhere it appears", () => {
    expect(applyTemplate("{x} == {x}", { x: "42" })).toBe("42 == 42")
  })

  it("leaves unknown placeholders untouched (literal `{key}`)", () => {
    expect(applyTemplate("a {unknown} b", {})).toBe("a {unknown} b")
  })

  it("does not infinite-loop when the substitution itself contains brace tokens", () => {
    expect(applyTemplate("{x}", { x: "{y}" })).toBe("{y}")
  })

  it("only matches `{<word>}` — single-char keys included, but ignores spaces and punctuation", () => {
    expect(applyTemplate("{a} {b_1} { space } {dash-key}", { a: "A", b_1: "B" })).toBe(
      "A B { space } {dash-key}"
    )
  })

  it("preserves keys whose value is the empty string", () => {
    expect(applyTemplate("[{x}]", { x: "" })).toBe("[]")
  })

  it("works with realistic prompt content", () => {
    const out = applyTemplate("Chunks:\n{chunks}", { chunks: "[c1]\nfoo\n\n---\n\n[c2]\nbar" })
    expect(out).toContain("[c1]")
    expect(out).toContain("[c2]")
  })
})

// These structural tests anchor the prompt contracts so refactors that
// accidentally drop a schema field, a section header, or a privacy clause
// trip the suite immediately. We deliberately do NOT snapshot the full
// prompts — those are tuned manually and snapshots create churn.
describe("PROMPT contracts — shared preamble", () => {
  const prompts: ReadonlyArray<readonly [string, string]> = [
    ["STYLE_AGENT_PROMPT", STYLE_AGENT_PROMPT],
    ["PLAYBOOK_AGENT_PROMPT", PLAYBOOK_AGENT_PROMPT],
    ["KNOWLEDGE_AGENT_PROMPT", KNOWLEDGE_AGENT_PROMPT],
    ["SYNTHESIZER_PROMPT", SYNTHESIZER_PROMPT],
    ["EVALUATOR_PROMPT", EVALUATOR_PROMPT],
  ]

  test.each(prompts)("%s declares the multi-agent pipeline preamble", (_name, prompt) => {
    expect(prompt).toContain("multi-agent pipeline")
    expect(prompt).toContain("digital twin")
  })

  test.each(prompts)("%s warns about PII placeholders", (_name, prompt) => {
    expect(prompt).toContain("<EMAIL_001>")
    expect(prompt).toContain("<NAME_002>")
    expect(prompt).toContain("opaque identifiers")
  })

  test.each(prompts)("%s requires strict JSON output", (_name, prompt) => {
    expect(prompt).toContain("strict JSON only")
  })
})

describe("STYLE_AGENT_PROMPT schema fields", () => {
  it("declares the four sample fields", () => {
    expect(STYLE_AGENT_PROMPT).toContain('"contextLabel"')
    expect(STYLE_AGENT_PROMPT).toContain('"original"')
    expect(STYLE_AGENT_PROMPT).toContain('"summary"')
    expect(STYLE_AGENT_PROMPT).toContain('"tone"')
  })
  it("references {chunks} interpolation", () => {
    expect(STYLE_AGENT_PROMPT).toContain("{chunks}")
  })
})

describe("PLAYBOOK_AGENT_PROMPT schema fields", () => {
  it("declares the playbook structural fields", () => {
    for (const field of ['"title"', '"trigger"', '"steps"', '"examples"', '"confidence"']) {
      expect(PLAYBOOK_AGENT_PROMPT).toContain(field)
    }
  })
  it("references {chunks} interpolation", () => {
    expect(PLAYBOOK_AGENT_PROMPT).toContain("{chunks}")
  })
})

describe("KNOWLEDGE_AGENT_PROMPT schema fields", () => {
  it("declares both top-level lists", () => {
    expect(KNOWLEDGE_AGENT_PROMPT).toContain('"entities"')
    expect(KNOWLEDGE_AGENT_PROMPT).toContain('"perChunk"')
  })
  it("declares all five role types in the role enum hint", () => {
    expect(KNOWLEDGE_AGENT_PROMPT).toContain("person|team|project|system|concept")
  })
  it("references {chunks} interpolation", () => {
    expect(KNOWLEDGE_AGENT_PROMPT).toContain("{chunks}")
  })
})

describe("SYNTHESIZER_PROMPT schema fields", () => {
  it("declares the character + skills shape", () => {
    expect(SYNTHESIZER_PROMPT).toContain('"character"')
    expect(SYNTHESIZER_PROMPT).toContain('"skills"')
    expect(SYNTHESIZER_PROMPT).toContain('"systemPrompt"')
    expect(SYNTHESIZER_PROMPT).toContain('"voiceSummary"')
    expect(SYNTHESIZER_PROMPT).toContain('"sourcePlaybookId"')
  })
  it("references both {profile} and {chunks} interpolation", () => {
    expect(SYNTHESIZER_PROMPT).toContain("{profile}")
    expect(SYNTHESIZER_PROMPT).toContain("{chunks}")
  })
  it("encodes the confidence ≥ 0.6 floor for skill emission", () => {
    expect(SYNTHESIZER_PROMPT).toContain("0.6")
  })
})

describe("EVALUATOR_PROMPT schema fields", () => {
  it("declares evaluation envelope fields", () => {
    expect(EVALUATOR_PROMPT).toContain('"draftId"')
    expect(EVALUATOR_PROMPT).toContain('"qualityScore"')
    expect(EVALUATOR_PROMPT).toContain('"concerns"')
    expect(EVALUATOR_PROMPT).toContain('"suggestions"')
  })
  it("references {drafts} interpolation", () => {
    expect(EVALUATOR_PROMPT).toContain("{drafts}")
  })
})
