import { STANDALONE_ANSWER_SYSTEM_PROMPT } from "@cognia/web-search/standalone-answer"
import { validatePromptBody } from "@/lib/prompts/template"
import { STANDALONE_SEARCH_ANSWER_PROMPT } from "./standalone-answer-prompt"

it("ships the package's own answer prompt as its default", () => {
  expect(STANDALONE_SEARCH_ANSWER_PROMPT.defaultBody).toBe(STANDALONE_ANSWER_SYSTEM_PROMPT)
  expect(STANDALONE_SEARCH_ANSWER_PROMPT.scopes).toEqual(["account"])
  expect(
    validatePromptBody(STANDALONE_SEARCH_ANSWER_PROMPT, STANDALONE_ANSWER_SYSTEM_PROMPT)
  ).toEqual([])
})
