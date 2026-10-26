import {
  EVALUATOR_PROMPT,
  KNOWLEDGE_AGENT_PROMPT,
  PLAYBOOK_AGENT_PROMPT,
  STYLE_AGENT_PROMPT,
  SYNTHESIZER_PROMPT,
} from "./prompts"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { validatePromptBody } from "@/lib/prompts/template"

describe("rendering the distill templates (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("inserts the agent data once, never re-scanning it for placeholders", async () => {
    const { text } = await resolvePromptAsync(SYNTHESIZER_PROMPT, {
      values: { profile: "P {{chunks}}", chunks: "[c1]\nfoo" },
    })
    expect(text).toContain("Profile:\nP {{chunks}}\n")
    expect(text.endsWith("Recent chunks (sample):\n[c1]\nfoo")).toBe(true)
  })

  it("keeps the parsed JSON keys required in a customized body", () => {
    expect(validatePromptBody(STYLE_AGENT_PROMPT, "List samples.\n{{chunks}}")).toEqual([
      { code: "missing-fragment", fragment: '"samples"' },
    ])
  })

  it("applies an account override with the agent's data", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: EVALUATOR_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por",
          body: 'Review harshly. Return {"evaluations": []}\n{{drafts}}',
          contractVersion: EVALUATOR_PROMPT.contractVersion,
        },
      ])
    )
    const { text } = await resolvePromptAsync(EVALUATOR_PROMPT, { values: { drafts: "D1" } })
    expect(text).toBe('Review harshly. Return {"evaluations": []}\nD1')
  })
})

// These structural tests anchor the prompt contracts so refactors that
// accidentally drop a schema field, a section header, or a privacy clause
// trip the suite immediately. We deliberately do NOT snapshot the full
// prompts — those are tuned manually and snapshots create churn.
describe("PROMPT contracts — shared preamble", () => {
  const prompts: ReadonlyArray<readonly [string, string]> = [
    ["STYLE_AGENT_PROMPT", STYLE_AGENT_PROMPT.defaultBody],
    ["PLAYBOOK_AGENT_PROMPT", PLAYBOOK_AGENT_PROMPT.defaultBody],
    ["KNOWLEDGE_AGENT_PROMPT", KNOWLEDGE_AGENT_PROMPT.defaultBody],
    ["SYNTHESIZER_PROMPT", SYNTHESIZER_PROMPT.defaultBody],
    ["EVALUATOR_PROMPT", EVALUATOR_PROMPT.defaultBody],
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
    expect(STYLE_AGENT_PROMPT.defaultBody).toContain('"contextLabel"')
    expect(STYLE_AGENT_PROMPT.defaultBody).toContain('"original"')
    expect(STYLE_AGENT_PROMPT.defaultBody).toContain('"summary"')
    expect(STYLE_AGENT_PROMPT.defaultBody).toContain('"tone"')
  })
  it("references {{chunks}} interpolation", () => {
    expect(STYLE_AGENT_PROMPT.defaultBody).toContain("{{chunks}}")
  })
})

describe("PLAYBOOK_AGENT_PROMPT schema fields", () => {
  it("declares the playbook structural fields", () => {
    for (const field of ['"title"', '"trigger"', '"steps"', '"examples"', '"confidence"']) {
      expect(PLAYBOOK_AGENT_PROMPT.defaultBody).toContain(field)
    }
  })
  it("references {{chunks}} interpolation", () => {
    expect(PLAYBOOK_AGENT_PROMPT.defaultBody).toContain("{{chunks}}")
  })
})

describe("KNOWLEDGE_AGENT_PROMPT schema fields", () => {
  it("declares both top-level lists", () => {
    expect(KNOWLEDGE_AGENT_PROMPT.defaultBody).toContain('"entities"')
    expect(KNOWLEDGE_AGENT_PROMPT.defaultBody).toContain('"perChunk"')
  })
  it("declares all five role types in the role enum hint", () => {
    expect(KNOWLEDGE_AGENT_PROMPT.defaultBody).toContain("person|team|project|system|concept")
  })
  it("references {{chunks}} interpolation", () => {
    expect(KNOWLEDGE_AGENT_PROMPT.defaultBody).toContain("{{chunks}}")
  })
})

describe("SYNTHESIZER_PROMPT schema fields", () => {
  it("declares the character + skills shape", () => {
    expect(SYNTHESIZER_PROMPT.defaultBody).toContain('"character"')
    expect(SYNTHESIZER_PROMPT.defaultBody).toContain('"skills"')
    expect(SYNTHESIZER_PROMPT.defaultBody).toContain('"systemPrompt"')
    expect(SYNTHESIZER_PROMPT.defaultBody).toContain('"voiceSummary"')
    expect(SYNTHESIZER_PROMPT.defaultBody).toContain('"sourcePlaybookId"')
  })
  it("references both {profile} and {{chunks}} interpolation", () => {
    expect(SYNTHESIZER_PROMPT.defaultBody).toContain("{{profile}}")
    expect(SYNTHESIZER_PROMPT.defaultBody).toContain("{{chunks}}")
  })
  it("encodes the confidence ≥ 0.6 floor for skill emission", () => {
    expect(SYNTHESIZER_PROMPT.defaultBody).toContain("0.6")
  })
})

describe("EVALUATOR_PROMPT schema fields", () => {
  it("declares evaluation envelope fields", () => {
    expect(EVALUATOR_PROMPT.defaultBody).toContain('"draftId"')
    expect(EVALUATOR_PROMPT.defaultBody).toContain('"qualityScore"')
    expect(EVALUATOR_PROMPT.defaultBody).toContain('"concerns"')
    expect(EVALUATOR_PROMPT.defaultBody).toContain('"suggestions"')
  })
  it("references {{drafts}} interpolation", () => {
    expect(EVALUATOR_PROMPT.defaultBody).toContain("{{drafts}}")
  })
})
