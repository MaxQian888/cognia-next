import { MEMORY_RERANK_SYSTEM_PROMPT } from "@cognia/memory/retrieve/llm-rerank"
import { validatePromptBody } from "@/lib/prompts/template"
import { MEMORY_RERANK_PROMPT } from "./rerank-prompt"

it("ships the package's own rerank prompt as its default and keeps the JSON contract", () => {
  expect(MEMORY_RERANK_PROMPT.defaultBody).toBe(MEMORY_RERANK_SYSTEM_PROMPT)
  expect(validatePromptBody(MEMORY_RERANK_PROMPT, MEMORY_RERANK_SYSTEM_PROMPT)).toEqual([])
  expect(validatePromptBody(MEMORY_RERANK_PROMPT, "Rank these.")).toContainEqual({
    code: "missing-fragment",
    fragment: "JSON",
  })
})
