import { renderPromptTemplate, validatePromptBody } from "@/lib/prompts/template"
import { A2UI_CREATE_APP_PROMPT, A2UI_EDIT_APP_PROMPT } from "./generate-prompts"

describe("A2UI generation prompts", () => {
  it("are editable, agent-scoped entries whose shipped bodies validate", () => {
    for (const def of [A2UI_CREATE_APP_PROMPT, A2UI_EDIT_APP_PROMPT]) {
      expect(def).toMatchObject({
        operation: "replace-template",
        scopes: ["account", "agent"],
        consumers: ["lib/a2ui/ai-generate.ts"],
      })
      expect(validatePromptBody(def, def.defaultBody)).toEqual([])
    }
  })

  it("refuse an edit override that drops the patch tool or the target surface", () => {
    expect(validatePromptBody(A2UI_EDIT_APP_PROMPT, "Change it: {{instruction}}")).toEqual(
      expect.arrayContaining([
        { code: "missing-variable", name: "surfaceId" },
        { code: "missing-fragment", fragment: "a2ui_update_components" },
      ])
    )
  })

  // The tree is serialized JSON of any size; clipping it would truncate the
  // edit context mid-object.
  it("render a large component tree unclipped", () => {
    const tree = `\n\nCurrent components (JSON):\n${"x".repeat(500_000)}`
    const text = renderPromptTemplate(A2UI_EDIT_APP_PROMPT, A2UI_EDIT_APP_PROMPT.defaultBody, {
      surfaceId: "s",
      instruction: "i",
      language: "English",
      currentComponents: tree,
    })
    expect(text).toContain(tree)
  })
})
