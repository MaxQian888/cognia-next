import { validatePromptBody } from "@/lib/prompts/template"
import { BRIEF_MODE_PROMPT } from "./brief-mode"

it("ships a valid, concise brief-mode default", () => {
  expect(BRIEF_MODE_PROMPT.id).toBe("chat.brief-mode")
  expect(validatePromptBody(BRIEF_MODE_PROMPT, BRIEF_MODE_PROMPT.defaultBody)).toEqual([])
  expect(BRIEF_MODE_PROMPT.defaultBody).toContain("concisely")
})
