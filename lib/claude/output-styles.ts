// Output styles — user-customizable agent response style, injected into the
// system prompt. Claude Code parity (`/output-style`). Built on the same
// append-to-appendSystemPrompt mechanism as brief mode (`BRIEF_OUTPUT_SNIPPET`)
// and composes with it: a user can run brief + a style at once.
//
// Resolution precedence (in build-options): session > character > appSettings.
// `default` is a no-op; `custom` uses the user's free-form instruction.

export const OUTPUT_STYLE_IDS = ["default", "detailed", "bullets", "teacher", "custom"] as const
export type OutputStyleId = (typeof OUTPUT_STYLE_IDS)[number]

/** True when `value` is one of the known style ids. */
export function isOutputStyleId(value: unknown): value is OutputStyleId {
  return typeof value === "string" && (OUTPUT_STYLE_IDS as readonly string[]).includes(value)
}

// Preset snippets. Each is appended verbatim to appendSystemPrompt. Phrased as
// a direct instruction so it reads naturally after any base system prompt.
const PRESET_SNIPPETS: Record<Exclude<OutputStyleId, "default" | "custom">, string> = {
  detailed:
    "Output style — Detailed: give thorough, in-depth answers. Explain your reasoning, cover edge cases, and include concrete examples where they aid understanding.",
  bullets:
    "Output style — Bullet points: structure responses as concise, scannable bullet points wherever the content allows, rather than long paragraphs.",
  teacher:
    "Output style — Explanatory: explain concepts step by step as if teaching someone new to the topic, defining jargon the first time it appears.",
}

/**
 * Resolve the system-prompt snippet for an output style. Returns "" for the
 * default / unknown styles, and for a `custom` style with no instruction.
 */
export function resolveOutputStyleSnippet(
  style: string | undefined,
  customInstruction?: string
): string {
  if (!style || style === "default") return ""
  if (style === "custom") {
    const trimmed = customInstruction?.trim() ?? ""
    return trimmed ? `Output style — Custom: ${trimmed}` : ""
  }
  return PRESET_SNIPPETS[style as keyof typeof PRESET_SNIPPETS] ?? ""
}
