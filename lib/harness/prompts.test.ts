import {
  REFLECTOR_SYSTEM_PROMPT,
  SELECTOR_SYSTEM_PROMPT,
  STRUCTURED_EDIT_SCHEMA_TEXT,
  editorSystemPrompt,
  editorUserPrompt,
  roleOfDimension,
  selectorUserPrompt,
} from "./prompts"

describe("editor prompts", () => {
  it("states the role, the shared principles and the channel protocol", () => {
    const agentic = editorSystemPrompt("INV", "agentic")
    expect(agentic).toMatch(/invariant editor/)
    expect(agentic).toMatch(/Never encode this task's answer/)
    expect(agentic).toMatch(/untrusted run/)
    expect(agentic).toMatch(/NOTES\.md/)
    expect(agentic).not.toContain(STRUCTURED_EDIT_SCHEMA_TEXT)
    const structured = editorSystemPrompt("COMPOSE", "structured")
    expect(structured).toMatch(/composer/)
    expect(structured).toContain(STRUCTURED_EDIT_SCHEMA_TEXT)
    expect(editorSystemPrompt("DOM", "structured")).toMatch(/domain editor/)
  })

  it("asks for a fresh proposal, a composition, or a fix of validator errors", () => {
    expect(editorUserPrompt({ role: "DOM" })).toBe("Propose your edits to the harness.")
    expect(editorUserPrompt({ role: "COMPOSE", round: 2, inlined: "FILES" })).toBe(
      "This is round 2. decisions/ holds what earlier rounds changed and how their harness did; build on what worked and do not repeat what did not.\nCompose one harness from the pool.\n\nFILES"
    )
    const retry = editorUserPrompt({ role: "INV", retryErrors: ["memory.md: too long"] })
    expect(retry).toMatch(/rejected by the harness validator/)
    expect(retry).toContain("- memory.md: too long")
    expect(retry).not.toContain("previous answer")
    const withAnswer = editorUserPrompt({
      role: "DOM",
      retryErrors: ["x"],
      previousAnswer: '{"decision":"edit"}',
    })
    expect(withAnswer).toContain('Your previous answer was:\n{"decision":"edit"}')
  })

  it("maps stage dimensions to roles", () => {
    expect(roleOfDimension("INV")).toBe("INV")
    expect(roleOfDimension("DOM")).toBe("DOM")
    expect(roleOfDimension("AGG")).toBe("COMPOSE")
    expect(roleOfDimension("COMPOSE")).toBe("COMPOSE")
  })
})

describe("judge prompts", () => {
  it("frames the selector as blind and deterministic-first", () => {
    expect(SELECTOR_SYSTEM_PROMPT).toMatch(/may be the unchanged original/)
    expect(SELECTOR_SYSTEM_PROMPT).toMatch(/do not overrule a failed check/)
    const user = selectorUserPrompt("Do it", [
      { id: "R1", rollout: "ROLL", produced: "FILES" },
      { id: "R2", rollout: "ROLL2", produced: "FILES2" },
    ])
    expect(user).toContain("===== RUN R1 =====")
    expect(user).toContain("----- files produced by R2 -----")
  })

  it("asks the reflector for edit verdicts and at most one lesson", () => {
    expect(REFLECTOR_SYSTEM_PROMPT).toMatch(
      /"helped", "hurt", "no observed effect", or "confounded"/
    )
    expect(REFLECTOR_SYSTEM_PROMPT).toMatch(/"experience": null \|/)
    expect(REFLECTOR_SYSTEM_PROMPT).toMatch(/"retrieved": \[/)
  })
})
