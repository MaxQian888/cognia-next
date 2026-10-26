import { renderPromptTemplate, validatePromptBody } from "@/lib/prompts/template"
import { CANVAS_REVIEW_PROMPT, CANVAS_SUGGESTIONS_PROMPT } from "./suggestion-prompts"

describe("canvas suggestion prompts", () => {
  it("are editable, session/workspace-scoped entries whose defaults validate", () => {
    for (const def of [CANVAS_SUGGESTIONS_PROMPT, CANVAS_REVIEW_PROMPT]) {
      expect(def).toMatchObject({
        operation: "replace-template",
        scopes: ["account", "workspace", "session"],
        consumers: ["hooks/canvas/use-canvas-suggestions.ts"],
      })
      expect(validatePromptBody(def, def.defaultBody)).toEqual([])
    }
  })

  it("declare the suggestion cap as the {{N}} variable", () => {
    expect(
      renderPromptTemplate(CANVAS_SUGGESTIONS_PROMPT, CANVAS_SUGGESTIONS_PROMPT.defaultBody, {
        N: "7",
      })
    ).toContain("propose AT MOST 7 concise")
    expect(
      renderPromptTemplate(CANVAS_REVIEW_PROMPT, CANVAS_REVIEW_PROMPT.defaultBody, {
        N: "7",
      })
    ).toContain("report AT MOST 7\nspecific")
  })

  it("refuse an override that drops the schema field names the answer is validated against", () => {
    expect(validatePromptBody(CANVAS_REVIEW_PROMPT, "Review it, {{N}} at most.")).toEqual(
      expect.arrayContaining([
        { code: "missing-fragment", fragment: "originalText" },
        { code: "missing-fragment", fragment: "suggestedText" },
      ])
    )
  })
})
