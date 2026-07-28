/** Append a selection-toolbar stock instruction while preserving the user's draft. */
export function mergeComposerIntentPrompt(draft: string, prompt: string): string {
  if (!draft) return prompt
  return `${draft}${draft.endsWith("\n") ? "\n" : "\n\n"}${prompt}`
}
