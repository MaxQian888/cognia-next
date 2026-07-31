import { mergeComposerIntentPrompt } from "./merge-composer-intent"

it("uses the prompt directly for an empty draft", () => {
  expect(mergeComposerIntentPrompt("", "Explain this selection.")).toBe("Explain this selection.")
})

it("appends the prompt without overwriting an existing draft", () => {
  expect(mergeComposerIntentPrompt("My existing question", "Explain this selection.")).toBe(
    "My existing question\n\nExplain this selection."
  )
})

it("does not add a third newline when the draft already ends with one", () => {
  expect(mergeComposerIntentPrompt("Existing draft\n", "Translate this.")).toBe(
    "Existing draft\n\nTranslate this."
  )
})
