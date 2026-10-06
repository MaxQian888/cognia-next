/** Append a selection-toolbar stock instruction while preserving the user's draft. */
export function mergeComposerIntentPrompt(
  draft: string,
  prompt: string,
  mode: "append" | "replace" = "append"
): string {
  if (mode === "replace") return prompt
  if (!prompt) return draft
  if (!draft) return prompt
  return `${draft}${draft.endsWith("\n") ? "\n" : "\n\n"}${prompt}`
}
